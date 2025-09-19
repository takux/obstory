import { MarkdownView, Notice, Plugin, type Editor, type EditorPosition } from "obsidian";
import type { EditorView } from "@codemirror/view";

import { DEFAULT_SETTINGS } from "./constants";
import { assembleRichContext } from "./contextAssembler";
import { requestCompletion } from "./openaiClient";
import { abortGhostInflight, createGhostExtension, acceptGhost, acceptGhostNextWord } from "./ghost";
import { ObstorySettingTab } from "./settingTab";
import { detectFormat, buildCommonInstructions, sanitizeInline, stripLeftOverlap } from "./format";
import { VaultIndex } from "./vaultIndex";
import type { AssembledContext, ObstorySettings } from "./types";

export default class ObstoryPlugin extends Plugin {
  settings: ObstorySettings;
  private vaultIndex!: VaultIndex;

  async onload() {
    await this.loadSettings();
    this.vaultIndex = new VaultIndex(this.app, () => this.settings);

    // this.addCommand({
    //   id: "obstory-complete",
    //   name: "Obstory: Complete Next Beat",
    //   checkCallback: (checking) => {
    //     const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    //     if (!view) return false;
    //     if (!checking) this.completeNext(view.editor);
    //     return true;
    //   }
    // });

    // this.addCommand({
    //   id: "obstory-rewrite-dialogue",
    //   name: "Obstory: Polish Selection as Dialogue",
    //   checkCallback: (checking) => {
    //     const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    //     if (!view) return false;
    //     if (!checking) this.rewriteDialogue(view.editor);
    //     return true;
    //   }
    // });

    this.addCommand({
      id: "obstory-accept-ghost",
      name: "Accept Ghost Suggestion",
      icon: "indent-increase",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.acceptGhostFromCommand(view.editor);
        return true;
      }
    });

    this.addCommand({
      id: "obstory-accept-ghost-chunk",
      name: "Accept Next Ghost Chunk",
      icon: "chevron-right",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.acceptGhostChunkFromCommand(view.editor);
        return true;
      }
    });

    this.addSettingTab(new ObstorySettingTab(this.app, this));

    this.registerEditorExtension(
      createGhostExtension({
        app: this.app,
        getSettings: () => this.settings,
        assembleContext: (editor, cursor) => this.assembleContext(editor, cursor)
      })
    );

    const rebuilder = () => this.vaultIndex.scheduleRebuild();
    this.registerEvent(this.app.vault.on("create", rebuilder));
    this.registerEvent(this.app.vault.on("modify", rebuilder));
    this.registerEvent(this.app.vault.on("delete", rebuilder));

    await this.vaultIndex.rebuild();
  }

  onunload() {
    abortGhostInflight();
  }

  private async completeNext(editor: Editor) {
    const providerId = this.settings.provider ?? "openai";
    const providerName = providerId === "openai" ? "OpenAI" : providerId;
    if (providerId !== "openai") {
      new Notice(`Provider '${providerName}' is not supported yet.`, 5000);
      return;
    }
    if (!this.settings.apiKey) {
      new Notice(`Please set your ${providerName} API key`, 4000);
      return;
    }

    const cursor = editor.getCursor();
    const selection = editor.getSelection();
    const context = await this.assembleContext(editor);
    const fmt = detectFormat(editor);

    const prompt = [
      `MODE: ${context.mode}`,
      "You are assisting continued screenplay writing. Suggest the next short beat (within one paragraph, 1-3 sentences).",
      ...buildCommonInstructions(fmt, context.mode, this.settings),
      "- Preserve existing character voices and formatting (dialogue / action / scene headings).",
      "- Stay consistent with [AFTER]; respect established setups and state.",
      "- Avoid heavy exposition or meta commentary—show through concrete action and implication.",
      "",
      `[NOTE] ${context.notePath}`,
      context.title ? `[TITLE] ${context.title}` : "",
      context.headingChain.length ? `[SECTION] ${context.headingChain.join(" > ")}` : "",
      context.outline ? `[OUTLINE]\n${context.outline}` : "",
      "[SECTION_SNIPPET]",
      context.sectionSnippet,
      "",
      "[BEFORE]",
      context.beforeWindow,
      "",
      "[AFTER]",
      context.afterWindow,
      "",
      context.vaultContext ? "[VAULT_CONTEXT]\n" + context.vaultContext : "",
      context.linkedContext ? "[LINKED_PAGES]\n" + context.linkedContext : "",
      context.listContext ? buildListContextBlock(context.listContext) : "",
      this.formatVaultHints(),
      selection ? "[FOCUS]\n" + selection : ""
    ].filter(Boolean).join("\n");

    const notice = new Notice("Obstory: Generating...", 0);
    try {
      const completion = await requestCompletion(this.settings, prompt);
      notice.hide();
      let cleaned = completion ? sanitizeInline(completion, fmt) : "";
      const left = editor.getLine(cursor.line)?.slice(0, cursor.ch) ?? "";
      cleaned = stripLeftOverlap(cleaned, left);
      if (!cleaned) {
        new Notice("The response was empty", 3000);
        return;
      }
      if (selection) {
        editor.replaceSelection(cleaned);
      } else {
        editor.replaceRange(cleaned, cursor);
      }
    } catch (error: any) {
      notice.hide();
      console.error(error);
      new Notice(`Generation error: ${error?.message ?? error}`, 5000);
    }
  }

  private async rewriteDialogue(editor: Editor) {
    const providerId = this.settings.provider ?? "openai";
    const providerName = providerId === "openai" ? "OpenAI" : providerId;
    if (providerId !== "openai") {
      new Notice(`Provider '${providerName}' is not supported yet.`, 5000);
      return;
    }
    if (!this.settings.apiKey) {
      new Notice(`Please set your ${providerName} API key`, 4000);
      return;
    }

    const selection = editor.getSelection();
    if (!selection) {
      new Notice("Select the range you want to polish as dialogue", 3000);
      return;
    }

    const context = await this.assembleContext(editor);
    const fmt = detectFormat(editor);

    const prompt = [
      `MODE: dialogue`,
      "Rewrite the selection as natural screenplay dialogue. Preserve meaning and intent while sharpening voice and rhythm.",
      ...buildCommonInstructions(fmt, "dialogue", this.settings),
      "- Emphasize conversational flow, pacing, and subtext.",
      "- Break lines and pauses like convincing dialogue.",
      "- Stay consistent with [AFTER]; do not introduce contradictions.",
      "",
      `[NOTE] ${context.notePath}`,
      context.title ? `[TITLE] ${context.title}` : "",
      context.headingChain.length ? `[SECTION] ${context.headingChain.join(" > ")}` : "",
      context.outline ? `[OUTLINE]\n${context.outline}` : "",
      "[SECTION_SNIPPET]",
      context.sectionSnippet,
      "",
      "[BEFORE]",
      context.beforeWindow,
      "",
      "[AFTER]",
      context.afterWindow,
      "",
      context.linkedContext ? "[LINKED_PAGES]\n" + context.linkedContext : "",
      "",
      "[TARGET]",
      selection
    ].filter(Boolean).join("\n");

    const notice = new Notice("Obstory: Rewriting...", 0);
    try {
      const completion = await requestCompletion(this.settings, prompt);
      notice.hide();
      if (!completion) {
        new Notice("The response was empty", 3000);
        return;
      }
      editor.replaceSelection(sanitizeInline(completion, fmt));
    } catch (error: any) {
      notice.hide();
      console.error(error);
      new Notice(`Generation error: ${error?.message ?? error}`, 5000);
    }
  }

  private async assembleContext(editor: Editor, cursorOverride?: EditorPosition): Promise<AssembledContext> {
    return assembleRichContext({
      app: this.app,
      settings: this.settings,
      vaultIndex: this.vaultIndex
    }, editor, cursorOverride);
  }

  private formatVaultHints(): string {
    const hints = this.vaultIndex.getHints();
    return hints.length ? `[VAULT_HINTS]\n- ${hints.join("\n- ")}` : "";
  }

  async loadSettings() {
    const saved: any = await this.loadData();
    let mutated = false;
    if (saved && typeof saved === "object") {
      if ("systemPrompt" in saved) {
        try { delete saved.systemPrompt; mutated = true; } catch {}
      }
      if ("vaultIndexHintsLimit" in saved) {
        try { delete saved.vaultIndexHintsLimit; mutated = true; } catch {}
      }
      if ("temperature" in saved) {
        try { delete saved.temperature; mutated = true; } catch {}
      }
      if ("enableGhostStream" in saved) {
        try { delete saved.enableGhostStream; mutated = true; } catch {}
      }
      if ("ghostDelayMs" in saved) {
        try { delete saved.ghostDelayMs; mutated = true; } catch {}
      }
      if ("guardFormatting" in saved) {
        try { delete saved.guardFormatting; mutated = true; } catch {}
      }
      if ("enableVaultIndex" in saved) {
        try { delete saved.enableVaultIndex; mutated = true; } catch {}
      }
      if ("vaultIndexFolders" in saved) {
        try { delete saved.vaultIndexFolders; mutated = true; } catch {}
      }
      if (mutated) {
        try { await this.saveData(saved); } catch {}
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private acceptGhostFromCommand(editor: Editor): void {
    this.runGhostCommand(editor, acceptGhost, "No ghost suggestion to accept yet");
  }

  private acceptGhostChunkFromCommand(editor: Editor): void {
    this.runGhostCommand(editor, acceptGhostNextWord, "No more ghost text to add yet");
  }

  private runGhostCommand(editor: Editor, action: (view: EditorView) => boolean, emptyMessage: string): void {
    if (!this.settings.enableGhost) {
      new Notice("Ghost suggestions are disabled", 3000);
      return;
    }
    if (!this.settings.apiKey) {
      new Notice("Set your OpenAI API key to use ghost suggestions", 4000);
      return;
    }

    const cm = (editor as any)?.cm as EditorView | undefined;
    if (!cm) {
      console.error("CM6 editor unavailable for ghost command");
      new Notice("Ghost suggestions are not available in this editor", 3000);
      return;
    }

    if (!action(cm)) {
      new Notice(emptyMessage, 3000);
    }
  }

}

function buildListContextBlock(listContext: AssembledContext["listContext"]): string {
  if (!listContext) return "";
  const siblings = listContext.siblings.length ? `siblings:\n- ${listContext.siblings.join("\n- ")}` : "";
  return [
    "[LIST_CONTEXT]",
    `prefix=${listContext.prefix}`,
    `depth=${listContext.depth}`,
    siblings
  ].filter(Boolean).join("\n");
}
