import { runKeyOf, type EvalScores } from "@tos-rag/core";
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
