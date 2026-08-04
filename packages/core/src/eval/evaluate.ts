import { charSpanMetrics } from "../metrics/charspan";
import { normalizeAnswer, squadScore } from "../metrics/squad";
import { isAbstention } from "../prompts";
import type { DocSpan } from "../types";
import { buildCragPrompt, parseCragVerdict } from "./crag";

/**
 * Per-run evaluation (PRD §8.7) — the "headline" slice: deterministic retrieval
 * and answer-overlap metrics plus CRAG correctness. Faithfulness, cosine, and
 * cost are deferred and stay null (each adds a distinct dependency).
 *
 * The only external dependency is the injected `Judge`; everything else is pure,
 * so the whole thing is unit-tested with a fake judge and no I/O.
 */

/** The LLM judge port. Core owns the prompt and parsing; this only calls it. */
export interface Judge {
  complete(prompt: string): Promise<string>;
}

export interface EvaluateInput {
  question: string;
  expectedAnswer: string;
  /** The generated answer under evaluation. */
  answer: string;
  /** Gold clause spans; empty for unanswerable questions (char metrics → null). */
  goldSpans: DocSpan[];
  /** The k retrieved chunk spans (doc + char range). */
  retrieved: DocSpan[];
}

/** One `evals` row (PRD §9). Deferred columns are typed `null` for this slice. */
export interface EvalScores {
  char_precision: number | null;
  char_recall: number | null;
  hit_at_8: number | null;
  squad_f1: number;
  squad_em: number;
  crag_score: -1 | 0 | 1;
  judge_explanation: string;
  faithfulness: null;
  cosine_sim: null;
  cost_usd: null;
}

/**
 * The `judge_explanation` values written by the rule-decided branches. Anything
 * that classifies stored rows as rule- vs judge-decided (e.g. rescore-crag)
 * must match against these, never re-typed literals. The Python analysis step
 * (`analysis/src/tosrag_analysis/db.py` JUDGED_QUERY) carries a cross-language
 * copy that must stay in sync.
 */
export const RULE_EXPLANATIONS = {
  exactMatch: "exact match",
  abstained: "abstained",
} as const;

/**
 * CRAG decision order (PRD §10.3, amended 2026-08-01), rules before the judge
 * so exact and abstention cases cost no API call:
 *   1. normalized exact hit → +1 (Accurate)
 *   2. abstention           → 0 (Missing)
 *   3. otherwise            → judge → +1 / −1
 *
 * Exact match is checked *first* so that on an unanswerable question — where
 * `expectedAnswer` is `ABSTENTION_TEXT` — a correct "I don't know" is scored
 * Accurate rather than Missing. Under the old order those 4 of 20 Phase-1
 * questions were unwinnable, capping a flawless run at 0.800. An abstention on
 * an *answerable* question still falls through to rule 2 and scores 0, because
 * it cannot match that question's reference answer.
 *
 * Exported as the single source of the rule half so re-scoring tools apply the
 * exact rules the evaluator writes; returns null when the judge owns the row.
 */
export function cragRuleVerdict(
  answer: string,
  expectedAnswer: string,
): { score: 1 | 0; explanation: string } | null {
  if (normalizeAnswer(answer) === normalizeAnswer(expectedAnswer)) {
    return { score: 1, explanation: RULE_EXPLANATIONS.exactMatch };
  }
  if (isAbstention(answer)) {
    return { score: 0, explanation: RULE_EXPLANATIONS.abstained };
  }
  return null;
}

async function cragScore(
  input: EvaluateInput,
  judge: Judge,
): Promise<{ score: -1 | 0 | 1; explanation: string }> {
  const rule = cragRuleVerdict(input.answer, input.expectedAnswer);
  if (rule) return rule;
  const raw = await judge.complete(
    buildCragPrompt(input.question, input.expectedAnswer, input.answer),
  );
  return parseCragVerdict(raw);
}

export async function evaluateRun(
  input: EvaluateInput,
  deps: { judge: Judge },
): Promise<EvalScores> {
  const char = charSpanMetrics(input.goldSpans, input.retrieved);
  const squad = squadScore(input.answer, input.expectedAnswer);
  const crag = await cragScore(input, deps.judge);

  return {
    char_precision: char?.precision ?? null,
    char_recall: char?.recall ?? null,
    hit_at_8: char?.hit ?? null,
    squad_f1: squad.f1,
    squad_em: squad.em,
    crag_score: crag.score,
    judge_explanation: crag.explanation,
    faithfulness: null,
    cosine_sim: null,
    cost_usd: null,
  };
}
