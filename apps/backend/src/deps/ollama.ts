import { GENERATION_MAX_TOKENS, GENERATION_SEED } from "@tos-rag/core";
import type { GenerationResult } from "../app";

export interface OllamaConfig {
  /** Base URL of the Ollama server, e.g. http://localhost:11434 */
  url: string;
  /** Ollama model tag, e.g. llama3.1:8b */
  model: string;
}

interface OllamaGenerateResponse {
  response: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function generateOllama(
  cfg: OllamaConfig,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerationResult> {
  const t0 = Date.now();
  const res = await fetchImpl(`${cfg.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        seed: GENERATION_SEED,
        num_predict: GENERATION_MAX_TOKENS,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Ollama generation failed for model ${cfg.model} at ${cfg.url}: ` +
        `${res.status} ${await res.text()}. Is Ollama running with that ` +
        `model pulled (\`ollama pull ${cfg.model}\`)?`,
    );
  }
  const json = (await res.json()) as OllamaGenerateResponse;
  return {
    answer: json.response.trim(),
    inputTokens: json.prompt_eval_count ?? 0,
    outputTokens: json.eval_count ?? 0,
    latencyMs: Date.now() - t0,
  };
}
