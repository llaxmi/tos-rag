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
 * CRAG decision order (PRD §10.3), rules before the judge so exact and
 * abstention cases cost no API call:
 *   1. abstention           → 0 (Missing)
 *   2. normalized exact hit → +1 (Accurate)
 *   3. otherwise            → judge → +1 / −1
 */
async function cragScore(
  input: EvaluateInput,
  judge: Judge,
): Promise<{ score: -1 | 0 | 1; explanation: string }> {
  if (isAbstention(input.answer)) {
    return { score: 0, explanation: "abstained" };
  }
  if (normalizeAnswer(input.answer) === normalizeAnswer(input.expectedAnswer)) {
    return { score: 1, explanation: "exact match" };
  }
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
