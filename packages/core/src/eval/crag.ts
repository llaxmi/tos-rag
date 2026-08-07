/**
 * CRAG-style correctness judging (PRD §10.3): a reference-guided BINARY verdict
 * from Claude Sonnet — accurate (+1) or incorrect (−1) — used only when the
 * rules-first shortcuts in `evaluateRun` do not already settle the score.
 *
 * The prompt and the parsing live here (pure, testable); the model call is an
 * injected `Judge` port. Prompt shape adapted from facebookresearch/CRAG
 * `prompts/templates.py`: explanation before score, few-shot, JSON output.
 */

import { extractJsonObject } from "./json";

/** A binary CRAG outcome. Missing (0) is decided by rule, never by the judge. */
export interface CragVerdict {
  score: -1 | 1;
  explanation: string;
}

export function buildCragPrompt(
  question: string,
  expectedAnswer: string,
  answer: string,
): string {
  return [
    "You grade whether a generated answer to a question about a Terms of Service",
    "document is correct, using a reference answer as the ground truth.",
    "",
    'Label "accurate" if the generated answer conveys the same meaning as the',
    "reference answer — paraphrases, reorderings, and extra correct detail are fine.",
    'Label "incorrect" if it contradicts the reference, states something the',
    "reference does not support, or misses the key point of the reference.",
    "",
    "Respond with ONLY a JSON object, explanation first:",
    '{"explanation": "<one sentence>", "score": "accurate" | "incorrect"}',
    "",
    "Example 1",
    "Question: How much notice does GitHub give before changing fees?",
    "Reference answer: At least 30 days' advance notice.",
    "Generated answer: GitHub notifies users a minimum of 30 days before price changes.",
    '{"explanation": "Both state at least 30 days\' notice before fee changes.", "score": "accurate"}',
    "",
    "Example 2",
    "Question: What is the minimum age to use GitHub?",
    "Reference answer: You must be at least 13 years old.",
    "Generated answer: You must be at least 18 years old.",
    '{"explanation": "The generated answer states the wrong minimum age.", "score": "incorrect"}',
    "",
    "Now grade this one.",
    `Question: ${question}`,
    `Reference answer: ${expectedAnswer}`,
    `Generated answer: ${answer}`,
  ].join("\n");
}

/**
 * Parses a judge response into a verdict. Tries JSON first, then a word-boundary
 * regex fallback (PRD §10.2 robustness). Throws — rather than defaulting — when
 * the outcome is genuinely unresolvable, because a silent default would bias
 * Truthfulness in one direction.
 */
export function parseCragVerdict(text: string): CragVerdict {
  const obj = extractJsonObject(text);
  if (obj) {
    const score = String(obj["score"] ?? "").trim().toLowerCase();
    if (score === "accurate" || score === "incorrect") {
      return {
        score: score === "accurate" ? 1 : -1,
        explanation: String(obj["explanation"] ?? "").trim(),
      };
    }
    // otherwise fall through to the regex fallback
  }

  const lowered = text.toLowerCase();
  const hasIncorrect = /\bincorrect\b/.test(lowered);
  // "inaccurate"/"incorrect" do not contain a word-boundary "accurate".
  const hasAccurate = /\baccurate\b/.test(lowered);
  if (hasAccurate !== hasIncorrect) {
    return { score: hasAccurate ? 1 : -1, explanation: text.trim() };
  }

  throw new Error(
    `Could not parse a CRAG verdict from judge output: ${JSON.stringify(text.slice(0, 200))}`,
  );
}
