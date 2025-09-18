export interface OpenAIModelOption {
  value: string;
  label: string;
  contextWindow: number;
  strengths: string;
}

/**
 * Curated list of OpenAI models that work with the Chat Completions API.
 * Keep ordered from most capable to fastest/cheapest for easy scanning.
 */
export const OPENAI_CHAT_MODELS: OpenAIModelOption[] = [
  {
    value: "gpt-4o",
    label: "gpt-4o",
    contextWindow: 128_000,
    strengths: "Flagship quality / reasoning"
  },
  {
    value: "gpt-4o-mini",
    label: "gpt-4o-mini",
    contextWindow: 128_000,
    strengths: "Fast + low cost"
  },
];
