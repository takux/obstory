import type { App, Editor, EditorPosition, TFile } from "obsidian";
import type { ObstorySettings, AssembledContext, ListContext } from "./types";
import { VaultIndex } from "./vaultIndex";

interface ContextDeps {
  app: App;
  settings: ObstorySettings;
  vaultIndex: VaultIndex;
}

export async function assembleRichContext(
  deps: ContextDeps,
  editor: Editor,
  cursorOverride?: EditorPosition
): Promise<AssembledContext> {
  const { app, settings, vaultIndex } = deps;
  const cursor = cursorOverride ?? editor.getCursor();
  const activeFile = app.workspace.getActiveFile();
  const notePath = (activeFile as TFile | null)?.path ?? "";
  const title = (activeFile as TFile | null)?.basename ?? "";

  const { headingChain, bounds } = getHeadingChainAndBounds(editor, cursor.line);
  const mode = detectSectionMode(editor, headingChain, cursor);
  const beforeWindow = sliceLines(editor, Math.max(0, cursor.line - settings.sectionWindowLinesBefore), cursor.line, 2000);
  const afterWindow = sliceLines(editor, cursor.line, Math.min(editor.lastLine(), cursor.line + settings.sectionWindowLinesAfter), 600);
  const sectionSnippet = sliceLines(editor, bounds.fromLine, bounds.toLine, 2000);
  const outline = buildOutline(editor, 80);
  const vaultContext = await gatherVaultContext(app, settings);
  const linkedContext = await gatherLinkedPageContext(app, settings, notePath, sectionSnippet);
  const listContext = getListContext(editor, cursor.line);
  await vaultIndex.refresh(headingChain[headingChain.length - 1] ?? "");

  return {
    notePath,
    title,
    mode,
    headingChain,
    beforeWindow,
    afterWindow,
    sectionSnippet,
    outline,
    vaultContext,
    linkedContext,
    listContext
  };
}

function getHeadingChainAndBounds(editor: any, line: number) {
  const lastLine = editor.lastLine();
  const headingRegex = /^(#{1,6})\s+(.+?)\s*$/;
  const chain: Array<{ level: number; text: string }> = [];

  for (let i = line; i >= 0; i--) {
    const text = editor.getLine(i) ?? "";
    const match = text.match(headingRegex);
    if (!match) continue;
    const level = match[1].length;
    const headingText = match[2].trim();
    while (chain.length && chain[0].level >= level) chain.shift();
    chain.unshift({ level, text: headingText });
  }

  let fromLine = 0;
  for (let i = line; i >= 0; i--) {
    if (headingRegex.test(editor.getLine(i) ?? "")) { fromLine = i + 1; break; }
  }
  let toLine = lastLine;
  for (let i = line + 1; i <= lastLine; i++) {
    if (headingRegex.test(editor.getLine(i) ?? "")) { toLine = i - 1; break; }
  }

  return {
    headingChain: chain.map((c) => c.text),
    bounds: { fromLine, toLine }
  };
}

function sliceLines(editor: any, fromLine: number, toLine: number, maxChars: number): string {
  const from = { line: Math.max(0, fromLine), ch: 0 };
  const to = { line: Math.max(fromLine, toLine), ch: Number.MAX_SAFE_INTEGER };
  const text = editor.getRange(from, to) ?? "";
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function buildOutline(editor: any, maxItems = 50): string {
  const lastLine = editor.lastLine();
  const headingRegex = /^(#{1,6})\s+(.+?)\s*$/;
  const items: string[] = [];
  for (let i = 0; i <= lastLine && items.length < maxItems; i++) {
    const text = editor.getLine(i) ?? "";
    const match = text.match(headingRegex);
    if (!match) continue;
    const level = match[1].length;
    const headingText = match[2].trim();
    items.push(`${" ".repeat(Math.max(0, level - 1))}- ${headingText}`);
  }
  return items.join("\n");
}

async function gatherVaultContext(app: App, settings: ObstorySettings): Promise<string> {
  if (!settings.enableVaultContext) return "";
  const patterns = settings.vaultContextFolderPatterns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!patterns.length) return "";

  const files = app.vault.getMarkdownFiles();
  const pick: TFile[] = files.filter((f) => patterns.some((p) => f.path.startsWith(p + "/") || f.path.startsWith(p)));
  if (!pick.length) return "";

  const maxChars = Math.max(500, settings.vaultContextMaxChars);
  let acc = "";
  for (const file of pick.slice(0, 10)) {
    try {
      const txt = await app.vault.read(file);
      if (!txt) continue;
      const head = txt.length > 800 ? txt.slice(0, 800) : txt;
      acc += `# ${file.basename}\n${head}\n\n`;
      if (acc.length >= maxChars) break;
    } catch (error) {
      console.error("Vault context read error", error);
    }
  }
  if (acc.length > maxChars) acc = acc.slice(0, maxChars);
  return acc.trim();
}

async function gatherLinkedPageContext(app: App, settings: ObstorySettings, notePath: string, sectionSnippet: string): Promise<string> {
  const seen = new Set<string>();
  const links: Array<{ path: string; fragment?: string }> = [];

  const wikiRe = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiRe.exec(sectionSnippet))) {
    const inside = (match[1] || "").trim();
    const linkPart = inside.split("|")[0]?.trim() || inside;
    const [path, fragment] = linkPart.split("#");
    if (!path) continue;
    const key = `${path}#${fragment || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ path, fragment });
  }

  const mdRe = /\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = mdRe.exec(sectionSnippet))) {
    const href = (match[1] || "").trim();
    const [path, fragment] = href.split("#");
    if (!path) continue;
    if (!/\.md$/i.test(path) && !/\//.test(path)) continue;
    const key = `${path}#${fragment || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ path, fragment });
  }

  if (!links.length) return "";

  const MAX_FILES = 5;
  const MAX_TOTAL = Math.max(500, Math.floor(settings.vaultContextMaxChars * 0.8));
  const out: string[] = [];
  for (const { path, fragment } of links.slice(0, MAX_FILES)) {
    try {
      const file = app.metadataCache.getFirstLinkpathDest(path, notePath) as TFile | null;
      if (!file) continue;
      if (file.extension?.toLowerCase() !== "md") continue;
      const txt = await app.vault.read(file);
      if (!txt) continue;
      let snippet = "";
      if (fragment) {
        const lines = txt.split(/\r?\n/);
        const headingIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === fragment.trim().toLowerCase());
        if (headingIndex >= 0) {
          const tail: string[] = [];
          for (let j = headingIndex + 1; j < lines.length; j++) {
            if (/^#{1,6}\s+/.test(lines[j])) break;
            if (tail.join("\n").length > 800) break;
            tail.push(lines[j]);
          }
          snippet = tail.join("\n").trim();
        }
      }
      if (!snippet) {
        snippet = txt.length > 800 ? txt.slice(0, 800) : txt;
      }
      out.push(`# ${file.basename}${fragment ? ` #${fragment}` : ""}\n${snippet}`.trim());
      if (out.join("\n\n").length >= MAX_TOTAL) break;
    } catch (error) {
      console.error("Linked page context error", error);
    }
  }
  const acc = out.join("\n\n");
  return acc.length > MAX_TOTAL ? acc.slice(0, MAX_TOTAL) : acc;
}

function getListContext(editor: any, line: number): ListContext | null {
  const text = editor.getLine(line) ?? "";
  const match = text.match(/^([ \t]*)([-*+]\s|\d+\.\s|・\s)/);
  if (!match) return null;
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  const prefix = indent + marker;
  const depth = Math.floor((indent.replace(/\t/g, "  ")).length / 2);
  const siblings: string[] = [];
  for (let i = line - 1; i >= 0 && siblings.length < 6; i--) {
    const lineText = editor.getLine(i) ?? "";
    const siblingMatch = lineText.match(/^([ \t]*)([-*+]\s|\d+\.\s|・\s)(.*)$/);
    if (!siblingMatch) break;
    if ((siblingMatch[1] ?? "") !== indent) break;
    const body = (siblingMatch[3] ?? "").trim();
    if (body) siblings.unshift(body);
  }
  return { prefix, depth, siblings };
}

function detectSectionMode(
  editor: any,
  headingChain: string[],
  cursorOverride?: EditorPosition
): "dialogue" | "stage" | "list" | "markdown" {
  const cur = cursorOverride ?? editor.getCursor();
  const lineText: string = editor.getLine(cur.line) ?? "";
  const left = lineText.slice(0, cur.ch);
  const lastHead = (headingChain?.[headingChain.length - 1] || "").toLowerCase();
  if (/^\s*[-*+]\s|^\s*\d+\.\s/.test(left)) return "list";
  if (/["“”]/.test(left)) return "dialogue";
  if (/dialogue|conversation/.test(lastHead)) return "dialogue";
  if (/stage|action|description/.test(lastHead)) return "stage";
  return "markdown";
}
