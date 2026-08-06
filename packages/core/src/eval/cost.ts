import { MODEL_IDS } from "../schemas";

/**
 * Monetary cost of one run from its stored token counts (PRD §10.5). Pure
 * arithmetic — nothing here re-runs anything. Prices are per million tokens.
 *
 * Llama's $0 is the honest figure for a locally served model, but it means "no
 * API cost", not "free": hardware and electricity are excluded, and the report
 * has to say so.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  [MODEL_IDS.opus]: { inputPerMTok: 5, outputPerMTok: 25 },
  [MODEL_IDS.llama]: { inputPerMTok: 0, outputPerMTok: 0 }, // local Ollama
};

/**
 * Rounded to 6 decimal places to match `evals.cost_usd` (`Decimal(10, 6)`), so
 * a stored value and a recomputed one compare equal instead of differing in
 * float noise.
 *
 * Throws on an unknown model: defaulting to 0 would record a paid model as free.
 */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    throw new Error(
      `Unknown model '${model}' — no published price. Add it to MODEL_PRICES; ` +
        "defaulting to 0 would record a paid model as free.",
    );
  }
  if (inputTokens < 0 || outputTokens < 0) {
    throw new Error(
      `Token counts must be non-negative (got ${inputTokens} in / ${outputTokens} out).`,
    );
  }
  const usd =
    (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
