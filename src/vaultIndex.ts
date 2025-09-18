import type { App } from "obsidian";
import { INTERNAL_SETTINGS } from "./internalSettings";
import type { ObstorySettings } from "./types";

const MAX_CACHE_ITEMS = 500;
const REBUILD_DEBOUNCE_MS = 1000;

export class VaultIndex {
  private hints: string[] = [];
  private cache: string[] = [];
  private rebuildTimer: number | null = null;

  constructor(private readonly app: App, private readonly getSettings: () => ObstorySettings) {}

  getHints(): string[] {
    return this.hints;
  }

  scheduleRebuild(): void {
    if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuild().catch(console.error);
    }, REBUILD_DEBOUNCE_MS);
  }

  async rebuild(): Promise<void> {
    const folders = INTERNAL_SETTINGS.vaultIndexFolders
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!folders.length) {
      this.cache = [];
      this.hints = [];
      return;
    }

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !folders.length || folders.some((folder) => file.path.startsWith(folder + "/") || file.path.startsWith(folder)));

    const collected: string[] = [];
    for (const file of files.slice(0, 200)) {
      try {
        const txt = await this.app.vault.read(file);
        const lines = txt.split(/\r?\n/);
        for (const line of lines) {
          if (/^\s*[-*+]\s+/.test(line) || /^\s*・\s+/.test(line)) {
            collected.push(line.trim().replace(/^[-*+・]\s+/, ""));
          }
        }
      } catch (error) {
        console.error("Vault index read error", error);
      }
    }

    this.cache = collected.slice(0, MAX_CACHE_ITEMS);
    const limit = Math.max(1, INTERNAL_SETTINGS.vaultIndexHintsLimit);
    this.hints = this.cache.slice(0, limit);
  }

  async refresh(currentHeading: string): Promise<void> {
    const folderValue = INTERNAL_SETTINGS.vaultIndexFolders.trim();
    if (!folderValue) {
      this.hints = [];
      return;
    }

    const key = (currentHeading || "").toLowerCase();
    const tokens = key.split(/\s+|・|:|：|\/|—|\-|_/).filter(Boolean);
    const source = this.cache.length ? this.cache : this.hints;

    if (!tokens.length) {
      const limit = Math.max(1, INTERNAL_SETTINGS.vaultIndexHintsLimit);
      this.hints = source.slice(0, limit);
      return;
    }

    const score = (hint: string) => tokens.reduce((acc, token) => acc + (hint.toLowerCase().includes(token) ? 1 : 0), 0);

    const ranked = source
      .map((hint) => ({ hint, score: score(hint) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, INTERNAL_SETTINGS.vaultIndexHintsLimit))
      .map((entry) => entry.hint);

    const limit = Math.max(1, INTERNAL_SETTINGS.vaultIndexHintsLimit);
    this.hints = ranked.length ? ranked : source.slice(0, limit);
  }
}
