import { MODEL_IDS, type Judge } from "@tos-rag/core";

/**
 * The LLM-judge adapter (PRD §8.7, §10.3): Claude Sonnet via the Anthropic
 * Messages API, implementing the core `Judge` port. The prompt and the parsing
 * of its reply live in `@tos-rag/core`; this only performs the call.
 *
 * Mirrors `deps/live.ts` generateOpus (raw fetch, temp 0) — no SDK. Judge
 * replies are short (one-sentence explanation + a score token), so max_tokens is
 * small; temperature 0 for maximum determinism.
 */

export interface JudgeEnv {
  ANTHROPIC_API_KEY?: string;
}

const JUDGE_MAX_TOKENS = 512;

export function createJudge(env: JudgeEnv): Judge {
  return {
    async complete(prompt: string): Promise<string> {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error(
          "The CRAG judge isn't configured — set ANTHROPIC_API_KEY to run evaluation.",
        );
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_IDS.judge,
          max_tokens: JUDGE_MAX_TOKENS,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Judge API failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      return json.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
    },
  };
}
