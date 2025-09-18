export interface InternalSettings {
  /**
   * Maximum number of indexed hints to surface alongside prompts.
   * Keep conservative to avoid token bloat while still providing useful context.
   */
  vaultIndexHintsLimit: number;
  /**
   * Base temperature for completions/ghost suggestions. Tuned for screenplay polish.
   */
  temperature: number;
  /**
   * Use streaming responses for ghost suggestions to surface results faster.
   */
  enableGhostStream: boolean;
  /**
   * Delay (ms) to wait after typing before triggering ghost suggestions.
   */
  ghostDelayMs: number;
  /**
   * Maintain output formatting guardrails (no headings mid-list, etc.).
   */
  guardFormatting: boolean;
  /**
   * Comma separated folders to index for vault hints. Leave empty to disable vault indexing.
   */
  vaultIndexFolders: string;
}

export const INTERNAL_SETTINGS: InternalSettings = {
  vaultIndexHintsLimit: 8,
  temperature: 0.7,
  enableGhostStream: true,
  ghostDelayMs: 800,
  guardFormatting: true,
  vaultIndexFolders: ""
};
