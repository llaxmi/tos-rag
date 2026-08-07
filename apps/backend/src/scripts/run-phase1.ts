/**
 * Runs Phase 1 of the experiment (PRD §7): 15 configs × 20 Round-1 questions ×
 * Llama = 300 runs. For each pair — retrieve → generate → evaluate → write a
 * `runs` + `evals` row. Resumable: completed runs (by the `runs` unique key) are
 * skipped, so an interrupted run continues where it left off (PRD §16 #3).
 *
 *   pnpm run-phase1                       # all pending runs
 *   pnpm run-phase1 --config sentence:256 # restrict to one config
 *   pnpm run-phase1 --limit 3             # first N questions per config (smoke)
 *
 * Needs a live DB (DATABASE_URL), a reachable Ollama, and ANTHROPIC_API_KEY for
 * the judge. The pure per-run logic is @tos-rag/core `runOne`; this wires the
 * real deps (via ./shared) and owns the planning.
 */
import "dotenv/config";
import {
  CHUNK_SIZES,
  MODEL_IDS,
  parseConfigRef,
  planRuns,
  STRATEGIES,
  type Strategy,
} from "@tos-rag/core";
import { getCompletedRunKeys, getQuestions, resolveConfigId } from "@tos-rag/db";
import { getFlag, parseLimitFlag } from "./args";
import { runScript } from "./entrypoint";
import {
  createOrchestratorDeps,
  executeRuns,
  logRunSummary,
  requirePhaseEnv,
  type RunTask,
} from "./shared";

const PHASE = 1;
const MODEL = "llama" as const; // Phase 1 generator (PRD §7)

interface Args {
  only?: { strategy: Strategy; chunkSize: number };
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const configArg = getFlag(argv, "--config");
  // Validated against the frozen grid rather than cast: a typo'd strategy would
  // otherwise surface as a missing-config-row error much further downstream.
  const only = configArg ? parseConfigRef(configArg) : undefined;
  return { only, limit: parseLimitFlag(argv) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = requirePhaseEnv();

  // The 15-config grid (optionally restricted), resolved to config ids. The
  // three reads are independent, so they overlap rather than queue up.
  const grid = args.only
    ? [args.only]
    : STRATEGIES.flatMap((strategy) =>
        CHUNK_SIZES.map((chunkSize) => ({ strategy, chunkSize })),
      );
  const [configs, allQuestions, done] = await Promise.all([
    Promise.all(
      grid.map(async (c) => ({ ...c, id: await resolveConfigId(c.strategy, c.chunkSize) })),
    ),
    getQuestions({ phase1: true }),
    getCompletedRunKeys(PHASE, MODEL_IDS.llama),
  ]);
  const byId = new Map(configs.map((c) => [c.id, c]));

  const questions = args.limit ? allQuestions.slice(0, args.limit) : allQuestions;
  const questionById = new Map(questions.map((q) => [q.id, q]));

  const pending = planRuns(
    configs.map((c) => c.id),
    questions.map((q) => q.id),
    done,
  );

  const total = configs.length * questions.length;
  console.log(
    `Phase 1 — ${configs.length} configs × ${questions.length} questions = ${total} runs; ` +
      `${total - pending.length} already done, ${pending.length} to run.\n`,
  );

  const tasks: RunTask[] = pending.map(({ configId, questionId }) => {
    const config = byId.get(configId)!;
    return {
      configId,
      config: { strategy: config.strategy, chunkSize: config.chunkSize },
      model: MODEL,
      question: questionById.get(questionId)!,
      label: `${config.strategy}:${config.chunkSize} · ${questionId}`,
    };
  });

  const { succeeded, failed } = await executeRuns(PHASE, tasks, () => createOrchestratorDeps(env));

  logRunSummary(succeeded.length, failed, total - pending.length);
  if (failed > 0) process.exitCode = 1;
}

runScript(main);
