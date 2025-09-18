import type { ObstorySettings } from "./types";

export const DEFAULT_SETTINGS: ObstorySettings = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  maxTokens: 600,
  donationUrl: "https://www.buymeacoffee.com/takux",
  primaryLanguage: "",
  enableGhost: true,
  ghostMaxTokens: 40,
  enableVaultContext: true,
  vaultContextMaxChars: 3000,
  vaultContextFolderPatterns: "",
  sectionWindowLinesBefore: 30,
  sectionWindowLinesAfter: 6,
};

const BASE_SYSTEM_PROMPT_LINES = [
  "You are a writing assistant specialized in screenplays.",
  "- Maintain the established prose style, character voices, and formatting (scene headings, action lines, dialogue).",
  "- Keep dialogue natural and concise; avoid unnecessary verbosity.",
  "- Match the original treatment of line breaks and bullet formatting.",
  "- Each completion should be a few sentences or a single paragraph; if prompting for more, end with a cue such as (continue / next beat).",
  "- Be concrete: surface proper nouns, actions, desires, and conflicts."
];

export function buildSystemPrompt(settings: ObstorySettings): string {
  const lines = [...BASE_SYSTEM_PROMPT_LINES];
  const language = settings.primaryLanguage?.trim();
  if (language) {
    lines.push(`- Respond primarily in ${language}. Keep other languages only when they already appear in the script or are clearly required.`);
  } else {
    lines.push("- Respond in English.");
  }
  return lines.join("\n");
}
