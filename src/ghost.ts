import { EditorView, ViewPlugin, Decoration, DecorationSet, WidgetType, keymap, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, Extension, Prec, Transaction } from "@codemirror/state";
import { App, Editor, EditorPosition, MarkdownView } from "obsidian";

import type { AssembledContext, ObstorySettings } from "./types";
import { computeNextChunk, detectFormat, sanitizeInline, stripLeftOverlap } from "./format";
import { requestGhostCompletion, requestGhostStream } from "./openaiClient";
import { INTERNAL_SETTINGS } from "./internalSettings";

interface GhostDeps {
  app: App;
  getSettings: () => ObstorySettings;
  assembleContext: (editor: Editor, cursor: EditorPosition) => Promise<AssembledContext>;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "sa-ghost";
    const first = this.text.split(/\r?\n/)[0] ?? "";
    span.textContent = first;
    return span;
  }
  ignoreEvent() { return true; }
}

type GhostState = { text: string; pos: number };

const setGhostEffect = StateEffect.define<GhostState | null>();

const ghostField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) {
        const value = effect.value;
        if (!value) return Decoration.none;
        const widget = Decoration.widget({ widget: new GhostWidget(value.text), side: 1 });
        return Decoration.set([widget.range(value.pos)]);
      }
    }
    if (tr.docChanged || tr.selection) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

let currentGhostController: GhostController | null = null;

export function createGhostExtension(deps: GhostDeps): Extension[] {
  const controller = new GhostController(deps);
  currentGhostController = controller;

  const plugin = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      const settings = deps.getSettings();
      if (!settings.enableGhost || !settings.apiKey) return;
      const transactions: readonly Transaction[] = update.transactions || [];
      const shouldClear = update.docChanged || update.selectionSet;
      const onlyGhostEffects = transactions.length > 0 && transactions.every((tr) => {
        if (!tr.effects?.length) return false;
        return tr.effects.every((effect: StateEffect<GhostState | null>) => effect.is(setGhostEffect));
      });
      if (shouldClear) {
        controller.schedule(update.view, { clear: true });
      } else if (transactions.length && !onlyGhostEffects) {
        controller.schedule(update.view, { clear: false });
      }
    }
  });

  const km = Prec.highest(keymap.of([
    { key: "Tab", run: acceptGhost },
    { key: "Alt-ArrowRight", run: acceptGhostNextWord },
    { key: "Escape", run: clearGhost }
  ]));

  return [ghostField, plugin, km];
}

export function abortGhostInflight(): void {
  try { currentGhostController?.cancel(); } catch (error) {
    console.error(error);
  }
}

export function acceptGhost(view: EditorView): boolean {
  abortGhostInflight();
  const deco = view.state.field(ghostField, false);
  if (!deco || deco.size === 0) return false;
  let text = "";
  deco.between(0, view.state.doc.length, (_from, _to, spec) => {
    const widget = (spec as any).widget as GhostWidget;
    if (widget?.text) text = widget.text;
  });
  if (!text) return false;
  const pos = view.state.selection.main.head;
  view.dispatch({ effects: setGhostEffect.of(null) });
  view.dispatch({ changes: { from: pos, to: pos, insert: text }, selection: { anchor: pos + text.length } });
  return true;
}

export function clearGhost(view: EditorView): boolean {
  const deco = view.state.field(ghostField, false);
  if (!deco || deco.size === 0) return false;
  view.dispatch({ effects: setGhostEffect.of(null) });
  return true;
}

export function acceptGhostNextWord(view: EditorView): boolean {
  abortGhostInflight();
  const deco = view.state.field(ghostField, false);
  if (!deco || deco.size === 0) return false;
  let text = "";
  deco.between(0, view.state.doc.length, (_from, _to, spec) => {
    const widget = (spec as any).widget as GhostWidget;
    if (widget?.text) text = widget.text;
  });
  if (!text) return false;
  const pos = view.state.selection.main.head;
  const chunk = computeNextChunk(text);
  if (!chunk) return false;
  const remain = text.slice(chunk.length);
  view.dispatch({ effects: setGhostEffect.of(null) });
  view.dispatch({ changes: { from: pos, to: pos, insert: chunk }, selection: { anchor: pos + chunk.length } });
  if (remain) view.dispatch({ effects: setGhostEffect.of({ text: remain, pos: pos + chunk.length }) });
  return true;
}

class GhostController {
  private timer: number | null = null;
  private lastSignature = "";
  private inflight: AbortController | null = null;

  constructor(private readonly deps: GhostDeps) {}

  cancel(): void {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
  }

  schedule(view: EditorView, options: { clear?: boolean } = {}): void {
    const settings = this.deps.getSettings();
    if (!settings.enableGhost || !settings.apiKey) return;
    if ((settings.provider ?? "openai") !== "openai") return;
    const { clear } = options;
    if (clear) {
      const deco = view.state.field(ghostField, false);
      if (deco && deco.size > 0) {
        window.requestAnimationFrame(() => {
          const still = view.state.field(ghostField, false);
          if (still && still.size > 0) {
            try {
              view.dispatch({ effects: setGhostEffect.of(null) });
            } catch (error) {
              console.error("ghost clear dispatch failed", error);
            }
          }
        });
      }
    }
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
    const delay = Math.max(200, INTERNAL_SETTINGS.ghostDelayMs);
    this.timer = window.setTimeout(() => this.generate(view, settings), delay);
  }

  private signature(context: string, head: number): string {
    const hashBase = `${context.slice(-1000)}@${head}`;
    let acc = 0;
    for (let i = 0; i < hashBase.length; i++) {
      acc = (acc * 31 + hashBase.charCodeAt(i)) | 0;
    }
    return String(acc);
  }

  private async generate(view: EditorView, settings: ObstorySettings): Promise<void> {
    this.timer = null;
    if ((settings.provider ?? "openai") !== "openai") return;
    const markdownView = this.deps.app.workspace.getActiveViewOfType(MarkdownView) as any;
    const editor: Editor | undefined = markdownView?.editor;
    if (!editor) return;
    const rawHead = view.state.selection.main.head ?? 0;
    const head = Math.min(rawHead, view.state.doc.length);
    const lineInfo = view.state.doc.lineAt(head);
    const leftView = lineInfo.text.slice(0, head - lineInfo.from);
    const rightView = lineInfo.text.slice(head - lineInfo.from);
    if (/\S/.test(rightView)) {
      view.dispatch({ effects: setGhostEffect.of(null) });
      return;
    }

    const cursor = editor.offsetToPos(head);

    const docBefore = view.state.doc.sliceString(0, head);
    const context = docBefore.slice(Math.max(0, docBefore.length - 4000));
    const sig = this.signature(docBefore, head);
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;

    const fmt = detectFormat(editor, cursor);
    let linkCheat = "";
    let beforeWin = "";
    let afterWin = "";
    let sectionInfo = "";
    let modeHint = "";
    let mode = "markdown";

    try {
      const assembled = await this.deps.assembleContext(editor, cursor);
      beforeWin = assembled.beforeWindow || "";
      afterWin = assembled.afterWindow || "";
      sectionInfo = assembled.headingChain?.length ? `[SECTION] ${assembled.headingChain.join(" > ")}` : "";
      if (assembled.linkedContext) {
        const cut = assembled.linkedContext.slice(0, 600);
        linkCheat = `[LINKED_PAGES]\n${cut}`;
      }
      mode = assembled.mode || "markdown";
      const lastHead = (assembled.headingChain?.[assembled.headingChain.length - 1] || "").toLowerCase();
      const isDialogue = /dialogue|conversation/.test(lastHead) || /["“”]/.test(leftView);
      const isStage = /stage|action|description/.test(lastHead);
      if (isDialogue) {
        modeHint = "- Keep it as dialogue. Avoid narration and use quotation marks where appropriate.";
      } else if (isStage) {
        modeHint = "- Output stage directions/description only. Do not include dialogue or quotes.";
      }
    } catch (error) {
      console.error("assemble context failed", error);
    }

    const primaryLanguage = settings.primaryLanguage?.trim();

    const userPrompt = [
      `MODE: ${mode}`,
      "Use the context below to suggest the next short continuation (about 1-2 sentences) that feels like a screenplay.",
      "- Preserve the existing formatting for dialogue, action, and headings.",
      "- Stop at a natural breakpoint, not mid-thought.",
      "- Do not repeat the left-hand text; only advance it.",
      primaryLanguage ? `- Write primarily in ${primaryLanguage}. Other languages are fine only when they already appear in the scene.` : "",
      modeHint || "",
      INTERNAL_SETTINGS.guardFormatting ? "- Do not emit Markdown headings (#, ##, ###). While in a list, do not output '#'." : "",
      INTERNAL_SETTINGS.guardFormatting && fmt.isList ? `- Continue the current list line without adding '${fmt.marker}' or extra indentation.` : "",
      "",
      sectionInfo,
      "[BEFORE]",
      beforeWin || context,
      "",
      afterWin ? "[AFTER]\n" + afterWin : "",
      linkCheat
    ].join("\n");

    try {
      if (INTERNAL_SETTINGS.enableGhostStream) {
        const controller = new AbortController();
        this.inflight = controller;
        const initialHead = head;
        let buffer = "";
        const minLen = 6;
        const boundary = (value: string) => /[.!?"'\]\s]$/.test(value);
        try {
          await requestGhostStream(settings, userPrompt, (delta) => {
            if (controller.signal.aborted) return;
            buffer += delta;
            const first = buffer.split(/\r?\n/)[0] ?? "";
            const currentHeadRaw = view.state.selection.main.head;
            const currentHead = Math.min(currentHeadRaw, view.state.doc.length);
            const line = view.state.doc.lineAt(currentHead);
            const leftNow = line.text.slice(0, currentHead - line.from);
            let cleaned = sanitizeInline(first, fmt);
            cleaned = stripLeftOverlap(cleaned, leftNow);
            if (!cleaned) {
              view.dispatch({ effects: setGhostEffect.of(null) });
              return;
            }
            if (cleaned.length < minLen && !boundary(cleaned)) return;
            const targetHead = Number.isFinite(currentHead) ? currentHead : initialHead;
            view.dispatch({ effects: setGhostEffect.of({ text: cleaned, pos: targetHead }) });
          }, controller.signal);
        } catch (error: any) {
          if (error?.name === "AbortError") {
            return;
          }
          console.error("Ghost stream error", error);
          const completion = await requestGhostCompletion(settings, userPrompt);
          const first = completion?.split(/\r?\n/)[0]?.trim() ?? "";
          let cleaned = sanitizeInline(first, fmt);
          const latestHeadRaw = view.state.selection.main.head;
          const latestHead = Math.min(latestHeadRaw, view.state.doc.length);
          const latestLine = view.state.doc.lineAt(latestHead);
          const latestLeft = latestLine.text.slice(0, latestHead - latestLine.from);
          cleaned = stripLeftOverlap(cleaned, latestLeft);
          if (!cleaned) {
            view.dispatch({ effects: setGhostEffect.of(null) });
          } else {
            view.dispatch({ effects: setGhostEffect.of({ text: cleaned, pos: latestHead }) });
          }
        } finally {
          this.inflight = null;
        }
      } else {
        const completion = await requestGhostCompletion(settings, userPrompt);
        const first = completion?.split(/\r?\n/)[0]?.trim() ?? "";
        let cleaned = sanitizeInline(first, fmt);
        const headNowRaw = view.state.selection.main.head;
        const headNow = Math.min(headNowRaw, view.state.doc.length);
        const lineNow = view.state.doc.lineAt(headNow);
        const leftNow = lineNow.text.slice(0, headNow - lineNow.from);
        cleaned = stripLeftOverlap(cleaned, leftNow);
        if (!cleaned) {
          view.dispatch({ effects: setGhostEffect.of(null) });
          return;
        }
        view.dispatch({ effects: setGhostEffect.of({ text: cleaned, pos: headNow }) });
      }
    } catch (error) {
      console.error("ghost generate error", error);
      view.dispatch({ effects: setGhostEffect.of(null) });
    }
  }
}
