import type { Editor, EditorPosition } from "obsidian";
import { INTERNAL_SETTINGS } from "./internalSettings";
import type { ObstorySettings } from "./types";

export interface FormatInfo {
  isList: boolean;
  indent: string;
  marker: string;
  right: string;
}

export function detectFormat(editor: Editor, cursorOverride?: EditorPosition): FormatInfo {
  const cur = cursorOverride ?? editor.getCursor();
  const lineText: string = editor.getLine(cur.line) ?? "";
  const left = lineText.slice(0, cur.ch);
  const right = lineText.slice(cur.ch);
  const listMatch = left.match(/^([ \t]*)([-*+]\s|\d+\.\s)/);
  const isList = !!listMatch;
  const indent = listMatch ? listMatch[1] : "";
  const marker = listMatch ? listMatch[2] : "";
  return {
    isList,
    indent,
    marker,
    right
  };
}

export function buildCommonInstructions(fmt: FormatInfo, mode: string, settings: ObstorySettings): string[] {
  const rules = [
    "- Do not generate new headings (#+) or meta commentary.",
    "- Do not repeat the left-hand text; only continue it.",
    "- Deliver a natural stopping point instead of cutting mid-sentence.",
  ];
  if (INTERNAL_SETTINGS.guardFormatting) {
    rules.push("- Do not generate Markdown headings (#, ##, ###).");
    if (fmt.isList) rules.push(`- Continue the current list line without adding '${fmt.marker}' or extra indentation.`);
  }
  if (mode === "dialogue") rules.push("- Keep it as spoken dialogue. Use quotes appropriately and avoid narration.");
  if (mode === "stage") rules.push("- Write stage directions/description; do not include dialogue or quotes.");
  const language = settings.primaryLanguage?.trim();
  if (language) {
    rules.push(`- Write primarily in ${language}. Use other languages only when they already appear or the context clearly requires it.`);
  }
  return rules;
}

export function sanitizeInline(text: string, fmt: FormatInfo): string {
  let t = (text ?? "").replace(/\r?\n/g, " ").trim();
  t = t.replace(/^#{1,6}\s*/g, "");
  if (fmt.isList) {
    t = t.replace(/\s*#{1,6}\s*/g, " ");
    t = t.replace(/^([-*+]\s|\d+\.\s)/, "");
    t = t.replace(/[.!?]+$/u, "");
  }
  if (fmt.right && t.endsWith(fmt.right[0])) {
    t = t.slice(0, -1);
  }
  return t;
}

export function stripLeftOverlap(suggestion: string, left: string): string {
  if (!suggestion || !left) return suggestion || "";
  const max = Math.min(suggestion.length, Math.min(40, left.length));
  for (let k = max; k >= 1; k--) {
    const tail = left.slice(-k);
    if (tail && suggestion.startsWith(tail)) {
      return suggestion.slice(k);
    }
  }
  return suggestion;
}

function isCJK(cp: number | undefined): boolean {
  if (cp === undefined) return false;
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf)
  );
}

export function computeNextChunk(text: string): string {
  if (!text) return "";
  const punct = new Set([",", ".", "!", "?", ")", "]", "}", "\""]);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t") return text.slice(0, i);
    if (punct.has(ch)) return text.slice(0, i + 1);
  }
  const cp0 = text.codePointAt(0);
  if (isCJK(cp0)) return text.slice(0, Math.min(2, text.length));
  const m = text.match(/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)?/);
  if (m) return m[0];
  return text.slice(0, Math.min(3, text.length));
}
