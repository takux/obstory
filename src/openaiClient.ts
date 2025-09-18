import type { ObstorySettings } from "./types";
import { buildSystemPrompt } from "./constants";
import { INTERNAL_SETTINGS } from "./internalSettings";

const OPENAI_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";

export async function requestCompletion(settings: ObstorySettings, userPrompt: string): Promise<string | undefined> {
  ensureOpenAI(settings);
  const body = {
    model: settings.model,
    temperature: INTERNAL_SETTINGS.temperature,
    max_tokens: settings.maxTokens,
    messages: [
      { role: "system", content: buildSystemPrompt(settings) },
      { role: "user", content: userPrompt }
    ]
  } as const;

  const res = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const json: any = await res.json();
  return json?.choices?.[0]?.message?.content?.trim();
}

export async function requestGhostCompletion(settings: ObstorySettings, userPrompt: string): Promise<string | undefined> {
  ensureOpenAI(settings);
  const body = {
    model: settings.model,
    temperature: INTERNAL_SETTINGS.temperature,
    max_tokens: Math.max(16, Math.min(256, settings.ghostMaxTokens)),
    messages: [
      { role: "system", content: buildSystemPrompt(settings) },
      { role: "user", content: userPrompt }
    ]
  } as const;

  const res = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) return undefined;
  const json: any = await res.json();
  return json?.choices?.[0]?.message?.content?.trim();
}

export async function requestGhostStream(
  settings: ObstorySettings,
  userPrompt: string,
  onDelta: (chunk: string) => void,
  signal: AbortSignal
): Promise<void> {
  ensureOpenAI(settings);
  const body = {
    model: settings.model,
    temperature: INTERNAL_SETTINGS.temperature,
    max_tokens: Math.max(16, Math.min(256, settings.ghostMaxTokens)),
    stream: true,
    messages: [
      { role: "system", content: buildSystemPrompt(settings) },
      { role: "user", content: userPrompt }
    ]
  } as const;

  const res = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok || !res.body) throw new Error(`stream unavailable: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\n\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split(/\n/).map((line) => line.trim());
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content ?? "";
          if (delta) onDelta(delta);
        } catch (error) {
          console.error("Ghost stream parse error", error);
        }
      }
    }
  }
}

function ensureOpenAI(settings: ObstorySettings): void {
  if (settings.provider !== "openai") {
    throw new Error(`Provider '${settings.provider}' is not supported yet.`);
  }
}
