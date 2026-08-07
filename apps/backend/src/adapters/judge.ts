import { MODEL_IDS, type Judge } from "@tos-rag/core";
import { callAnthropic } from "./anthropic";

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

/** CRAG verdicts are one sentence plus a score token. */
const JUDGE_MAX_TOKENS = 512;

/**
 * `maxTokens` is a parameter because faithfulness asks the same judge for a
 * *list* — statements, then one verdict each. At 512 a long answer truncates
 * mid-JSON and the reply cannot be parsed at all.
 *
 * `fetchImpl` is injectable, like `generateOllama`, so the truncation guard
 * below can be tested without a network call.
 */
export function createJudge(
  env: JudgeEnv,
  maxTokens = JUDGE_MAX_TOKENS,
  fetchImpl: typeof fetch = fetch,
): Judge {
  return {
    async complete(prompt: string): Promise<string> {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error(
          "The CRAG judge isn't configured — set ANTHROPIC_API_KEY to run evaluation.",
        );
      }
      const reply = await callAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        model: MODEL_IDS.judge,
        maxTokens,
        prompt,
        errorLabel: "Judge API failed",
        fetchImpl,
      });
      // A reply cut off at the cap is a JSON prefix with no closing brace. The
      // parsers' line fallback would read those broken lines as real content and
      // write a plausible-looking score with no error anywhere. Caught here,
      // where `stop_reason` lives, so it becomes a failed row instead. The CRAG
      // path gets the same protection for free.
      if (reply.stopReason === "max_tokens") {
        throw new Error(
          `Judge reply was truncated at the ${maxTokens}-token cap (stop_reason: max_tokens) — ` +
            "the JSON is incomplete and unsafe to parse.",
        );
      }
      return reply.text;
    },
  };
}
