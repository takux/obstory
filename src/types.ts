import type { TFile } from "obsidian";

export type ModelProvider = "openai";

export interface ObstorySettings {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
  donationUrl: string;
  primaryLanguage: string;
  enableGhost: boolean;
  ghostMaxTokens: number;
  enableVaultContext: boolean;
  vaultContextMaxChars: number;
  vaultContextFolderPatterns: string;
  sectionWindowLinesBefore: number;
  sectionWindowLinesAfter: number;
}

export interface ListContext {
  prefix: string;
  depth: number;
  siblings: string[];
}

export interface AssembledContext {
  notePath: string;
  title: string;
  mode: "dialogue" | "stage" | "list" | "markdown";
  headingChain: string[];
  beforeWindow: string;
  afterWindow: string;
  sectionSnippet: string;
  outline: string;
  vaultContext: string;
  linkedContext: string;
  listContext: ListContext | null;
}
