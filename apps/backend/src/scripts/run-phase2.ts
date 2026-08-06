/**
 * Runs Phase 2 of the experiment (PRD §7 Objective 2): the Phase-1 winning
 * config × {Llama 3.1 8B, Claude Opus 4.8} × all 30 questions = 60 runs. The
 * pipeline is held fixed; only the generator varies. For each pair —
 * retrieve → generate → evaluate → write a `runs` + `evals` row.
 *
 * Resumable: completed runs (by the `runs` unique key, per arm) are skipped, so
 * an interrupted or partially-failed run continues where it left off. That is
 * also why there is no retry around the paid Opus call — re-running picks up
 * exactly the gap.
 *
 *   pnpm run-phase2                 # all pending runs, both arms
 *   pnpm run-phase2 --model opus    # one arm only
 *   pnpm run-phase2 --limit 2       # first N questions per arm (cheap smoke)
 *
 * Needs a live DB (DATABASE_URL), a reachable Ollama, and ANTHROPIC_API_KEY for
 * both the Opus generator and the judge. The 10 questions held out of Phase 1
 * are included here; the `questions.phase1` flag marks them, and reporting them
 * separately is the analysis step's job (PRD §11).
 */
import "dotenv/config";
import {
  costUsd,
  GENERATOR_MODELS,
  MODEL_IDS,
  PHASE1_WINNER,
  planPhase2Runs,
  RETRIEVAL_K,
  type GeneratorModel,
} from "@tos-rag/core";
import { getCompletedRunKeys, getQuestions, resolveConfigId } from "@tos-rag/db";
import { parsePhase2Args } from "./args";
import {
  createOrchestratorDeps,
  executeRuns,
  logRunSummary,
  requirePhaseEnv,
  type RunTask,
} from "./shared";

const PHASE = 2;

/** Observed answer length for this task; the prompt side is derived, not guessed. */
const OPUS_OUTPUT_TOKENS = 200;

/**
 * Rough Opus spend, printed before the paid arm starts so the cost is visible
 * in advance rather than discovered afterwards (PRD §14 budget is $5). The
 * prompt size is derived from the frozen constants actually in force — a
 * hardcoded figure silently under-reports the moment k or the winning chunk
 * size is amended, which is exactly when an operator is relying on it.
 *
 * Priced through `costUsd`, the same function that writes `evals.cost_usd`, so
 * the estimate an operator budgets against and the cost the report quotes can
 * never come from two different copies of Anthropic's price list.
 */
function estimateOpusUsd(runs: number): number {
  const inputTokens = RETRIEVAL_K * PHASE1_WINNER.chunkSize + 300; // + question & template
  return runs * costUsd(MODEL_IDS.opus, inputTokens, OPUS_OUTPUT_TOKENS);
}

async function main(): Promise<void> {
  const args = parsePhase2Args(process.argv.slice(2));
  const env = requirePhaseEnv();

  const config = PHASE1_WINNER;
  const arms: readonly GeneratorModel[] = args.model ? [args.model] : GENERATOR_MODELS;

  // Resume is per-arm: each attempted arm has its own completed-run set. None
  // of these reads depend on each other, so they overlap rather than queue up.
  // (`executeRuns` asserts the config is actually ingested before spending
  // anything — see assertConfigsIngested.)
  const [configId, allQuestions, doneSets] = await Promise.all([
    resolveConfigId(config.strategy, config.chunkSize),
    getQuestions(),
    Promise.all(arms.map((model) => getCompletedRunKeys(PHASE, MODEL_IDS[model]))),
  ]);
  const doneByModel: Partial<Record<GeneratorModel, ReadonlySet<string>>> = Object.fromEntries(
    arms.map((model, i) => [model, doneSets[i]!]),
  );

  const questions = args.limit ? allQuestions.slice(0, args.limit) : allQuestions;
  const questionById = new Map(questions.map((q) => [q.id, q]));

  const pending = planPhase2Runs(
    configId,
    questions.map((q) => q.id),
    doneByModel,
    arms,
  );

  const total = arms.length * questions.length;
  const opusPending = pending.filter((p) => p.model === "opus").length;
  console.log(
    `Phase 2 — ${config.strategy}:${config.chunkSize} × ${arms.join(", ")} × ` +
      `${questions.length} questions = ${total} runs; ` +
      `${total - pending.length} already done, ${pending.length} to run.\n` +
      `Estimated Opus spend: ~$${estimateOpusUsd(opusPending).toFixed(2)} ` +
      `(${opusPending} paid runs; Llama is local and free).\n`,
  );

  const tasks: RunTask[] = pending.map(({ model, questionId }) => ({
    configId,
    config,
    model,
    question: questionById.get(questionId)!,
    label: `${model} · ${questionId}`,
  }));

  const { succeeded, failed } = await executeRuns(PHASE, tasks, () => createOrchestratorDeps(env));

  logRunSummary(succeeded.length, failed, total - pending.length);

  // Per-arm completeness: a paired Llama-vs-Opus comparison needs
  // questions.length runs in *each* attempted arm. `--model llama` alone is a
  // legitimate, intentionally single-arm invocation and must not be flagged —
  // hence this only checks arms this invocation actually attempted, not both
  // arms unconditionally. An attempted arm short of the full count (whether
  // from failures just above or an earlier interrupted run this invocation
  // didn't finish filling in) is loud rather than silently exiting 0.
  const armStatus = arms.map((model) => ({
    model,
    completed:
      (doneByModel[model]?.size ?? 0) + succeeded.filter((t) => t.model === model).length,
  }));
  for (const { model, completed } of armStatus) {
    console.log(
      `  ${MODEL_IDS[model]}: ${completed}/${questions.length} runs complete` +
        (completed < questions.length ? "  ⚠ INCOMPLETE" : ""),
    );
  }
  const incompleteArm = armStatus.some((a) => a.completed < questions.length);
  if (incompleteArm) {
    console.error(
      "\n⚠ At least one attempted arm has fewer than the full run count. The paired " +
        "Llama-vs-Opus comparison is not yet complete for this config — re-run " +
        "`pnpm run-phase2` (it resumes) before treating this as a finished Phase 2.",
    );
  }
  if (failed > 0 || incompleteArm) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `\n✗ ${err.message}\n` : err);
  process.exitCode = 1;
});
