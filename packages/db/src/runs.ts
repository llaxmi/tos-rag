import { runKeyOf, type EvalScores, type RetrievedRef } from "@tos-rag/core";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";

/** The `runs` row minus the `evals`, as produced by the orchestrator (PRD §9). */
export interface RunInsert {
  phase: number;
  configId: number;
  model: string;
  questionId: string;
  /** RetrievedRef[] — persisted to the `runs.retrieved` Json column. */
  retrieved: unknown;
  answer: string;
  retrievalMs: number;
  generationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The set of already-completed (config, question) keys for one (phase, model),
 * as `runKeyOf` strings — the resume set fed to `planRuns`. One query instead of
 * a per-run existence check.
 */
export async function getCompletedRunKeys(
  phase: number,
  model: string,
): Promise<Set<string>> {
  const rows = await prisma.runs.findMany({
    where: { phase, model },
    select: { config_id: true, question_id: true },
  });
  return new Set(rows.map((r) => runKeyOf(r.config_id, r.question_id)));
}

/**
 * Persists one completed run: the `runs` row and its `evals` row in a single
 * transaction, so a run and its scores are always written together (or not at
 * all — which is what makes a re-run retry cleanly). Returns the run id.
 */
export async function writeRun(
  run: RunInsert,
  scores: EvalScores,
): Promise<bigint> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.runs.create({
      data: {
        phase: run.phase,
        config_id: run.configId,
        model: run.model,
        question_id: run.questionId,
        retrieved: run.retrieved as Prisma.InputJsonValue,
        answer: run.answer,
        retrieval_ms: run.retrievalMs,
        generation_ms: run.generationMs,
        input_tokens: run.inputTokens,
        output_tokens: run.outputTokens,
      },
      select: { id: true },
    });
    await tx.evals.create({
      data: {
        run_id: created.id,
        char_precision: scores.char_precision,
        char_recall: scores.char_recall,
        hit_at_8: scores.hit_at_8,
        faithfulness: scores.faithfulness,
        crag_score: scores.crag_score,
        judge_explanation: scores.judge_explanation,
        squad_f1: scores.squad_f1,
        squad_em: scores.squad_em,
        cosine_sim: scores.cosine_sim,
        cost_usd: scores.cost_usd,
      },
    });
    return created.id;
  });
}

/** One stored run plus everything the metric backfill needs to score it. */
export interface BackfillRow {
  runId: bigint;
  phase: number;
  model: string;
  questionId: string;
  /** The question text — faithfulness needs it to make terse answers self-contained. */
  question: string;
  answer: string;
  expectedAnswer: string;
  /**
   * The stored spans, and the only source of document ids here: retrieval
   * searches the whole corpus, so the question's own `doc_id` is not what the
   * run actually read.
   */
  retrieved: RetrievedRef[];
  inputTokens: number | null;
  outputTokens: number | null;
  /** Current stored values — non-NULL means "already done, skip" (unless --force). */
  faithfulness: number | null;
  cosineSim: number | null;
  costUsd: number | null;
}

/**
 * Collected runs joined to their question and eval row, for the metric backfill.
 * Ordered by id so a resumed run processes rows in the same order as before.
 */
export async function getBackfillRows(opts?: {
  phase?: number;
}): Promise<BackfillRow[]> {
  const rows = await prisma.runs.findMany({
    where: opts?.phase === undefined ? {} : { phase: opts.phase },
    select: {
      id: true,
      phase: true,
      model: true,
      question_id: true,
      answer: true,
      retrieved: true,
      input_tokens: true,
      output_tokens: true,
      questions: { select: { expected_answer: true, question: true } },
      evals: { select: { faithfulness: true, cosine_sim: true, cost_usd: true } },
    },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({
    runId: r.id,
    phase: r.phase,
    model: r.model,
    questionId: r.question_id,
    question: r.questions.question,
    answer: r.answer,
    expectedAnswer: r.questions.expected_answer,
    retrieved: r.retrieved as unknown as RetrievedRef[],
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    faithfulness: r.evals?.faithfulness ?? null,
    cosineSim: r.evals?.cosine_sim ?? null,
    // Prisma hands back a Decimal for the Decimal(10,6) column.
    costUsd: r.evals?.cost_usd?.toNumber() ?? null,
  }));
}

/** The three columns the backfill is allowed to write, and nothing else. */
export interface EvalMetricPatch {
  faithfulness?: number | null;
  cosine_sim?: number | null;
  cost_usd?: number | null;
}

/**
 * Writes only the deferred metric columns of one `evals` row. Deliberately
 * narrow — it cannot reach `runs`, `crag_score`, or any collected score, so a
 * backfill can never move one.
 */
export async function updateEvalMetrics(
  runId: bigint,
  metrics: EvalMetricPatch,
): Promise<void> {
  await prisma.evals.update({ where: { run_id: runId }, data: metrics });
}
