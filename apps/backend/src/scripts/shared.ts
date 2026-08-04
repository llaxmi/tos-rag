/**
 * The parts both phase runners share: live-deps wiring and the
 * execute-and-persist loop. run-phase1 and run-phase2 differ only in how they
 * *plan* runs (config grid × fixed model vs fixed config × generator arms);
 * everything from "a pending (config, question, model) triple" onward is
 * identical, so it lives here once — a fix to the `writeRun` mapping or the
 * failure handling lands in both scripts by construction. Flag parsing lives
 * in the dependency-free `./args`, which this module deliberately does not
 * re-export: scripts that must not touch the DB import that one directly.
 */
import { MODEL_IDS, runOne, type OrchestratorDeps, type RunOneInput } from "@tos-rag/core";
import { countChunksForConfig, writeRun, type QuestionRow } from "@tos-rag/db";
import { createEmbedder, createJudge } from "../adapters";
import { createLiveDeps } from "../deps/live";

export interface PhaseEnv {
  ANTHROPIC_API_KEY: string;
  EMBEDDER?: string;
  EMBEDDER_DTYPE?: string;
  OLLAMA_URL?: string;
  OLLAMA_MODEL?: string;
}

/** Fail-fast env validation — before any DB work or the embedder load. */
export function requirePhaseEnv(): PhaseEnv {
  const { DATABASE_URL, ANTHROPIC_API_KEY, EMBEDDER, EMBEDDER_DTYPE, OLLAMA_URL, OLLAMA_MODEL } =
    process.env;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required (the CRAG judge; in Phase 2 also the Opus generator).",
    );
  }
  return { ANTHROPIC_API_KEY, EMBEDDER, EMBEDDER_DTYPE, OLLAMA_URL, OLLAMA_MODEL };
}

/**
 * The real pipeline deps. Loads the local ONNX embedder (~1.2GB, seconds of
 * startup), so callers construct this only once preflight checks have passed
 * and there is actually work to run. The Ollama defaults live in
 * `createLiveDeps`, shared with the server rather than restated here.
 */
export async function createOrchestratorDeps(env: PhaseEnv): Promise<OrchestratorDeps> {
  const embedder = await createEmbedder({
    EMBEDDER: env.EMBEDDER,
    EMBEDDER_DTYPE: env.EMBEDDER_DTYPE,
  });
  const live = createLiveDeps(env, embedder);
  return {
    retrieve: (q, opts) => live.retrieve(q, opts),
    generate: live.generate,
    judge: createJudge({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }),
  };
}

/** One planned run, fully resolved: everything `runOne` + `writeRun` need. */
export interface RunTask extends RunOneInput {
  /** The seeded row `runOne`'s `question` is drawn from (a structural superset). */
  question: QuestionRow;
  configId: number;
  /** Progress-line prefix, e.g. `recursive:256 · gh-q01` or `opus · gh-q01`. */
  label: string;
}

/**
 * Refuses to start when any config in `tasks` has no ingested chunks.
 *
 * `configs` rows are seeded independently of ingestion (packages/db/prisma/seed.ts
 * seeds all 15 up front), so `resolveConfigId` succeeding is not evidence a
 * config has chunks. Retrieval against zero chunks returns zero rows for every
 * question, and every run then writes a plausible-looking abstention
 * (crag_score = 0) — rows indistinguishable from real abstentions in the
 * database. This is the "assert before I/O" discipline `plan-ingest.ts` uses
 * for the offset invariant: crash before any run starts rather than let a
 * batch of false abstentions land silently.
 *
 * It lives here, not in a single runner, because Phase 1 is where it actually
 * bites — it sweeps 15 configs, so a partially-ingested corpus is the normal
 * failure mode, not the exceptional one.
 */
async function assertConfigsIngested(tasks: readonly RunTask[]): Promise<void> {
  const byConfigId = new Map(tasks.map((t) => [t.configId, t.config]));
  const counts = await Promise.all(
    [...byConfigId].map(async ([id, config]) => ({
      config,
      count: await countChunksForConfig(id),
    })),
  );
  const empty = counts.filter((c) => c.count === 0).map((c) => c.config);
  if (empty.length === 0) return;
  throw new Error(
    `No ingested chunks for ${empty.map((c) => `${c.strategy}:${c.chunkSize}`).join(", ")}. ` +
      "Refusing to run against an un-ingested config — every retrieval would return 0 rows " +
      "and every run would write a false abstention. Ingest first, e.g. " +
      `\`pnpm ingest -- --doc <doc> --strategy ${empty[0]!.strategy} --size ${empty[0]!.chunkSize}\` ` +
      "for each corpus document.",
  );
}

/**
 * The execute-and-persist loop shared by both phase runners: runOne →
 * writeRun → progress line, one task at a time (sequential by design —
 * latency is a measured metric). A failed task is logged and counted, never
 * retried; the resume plan picks up the gap on the next invocation.
 *
 * Takes a deps *factory* rather than built deps, and builds them only once
 * `tasks` is non-empty and the ingest preflight has passed — a fully-resumed
 * invocation (0 pending) never pays for loading the ~1.2GB embedder.
 */
export async function executeRuns(
  phase: number,
  tasks: readonly RunTask[],
  createDeps: () => Promise<OrchestratorDeps>,
): Promise<{ succeeded: RunTask[]; failed: number }> {
  if (tasks.length === 0) return { succeeded: [], failed: 0 };
  await assertConfigsIngested(tasks);
  const deps = await createDeps();
  const succeeded: RunTask[] = [];
  let failed = 0;
  for (const [i, task] of tasks.entries()) {
    try {
      const result = await runOne(task, deps);
      await writeRun(
        {
          phase,
          configId: task.configId,
          model: MODEL_IDS[task.model],
          questionId: task.question.id,
          retrieved: result.retrieved,
          answer: result.answer,
          retrievalMs: result.retrieval_ms,
          generationMs: result.generation_ms,
          inputTokens: result.input_tokens,
          outputTokens: result.output_tokens,
        },
        result.scores,
      );
      succeeded.push(task);
      const recall = result.scores.char_recall;
      console.log(
        `[${i + 1}/${tasks.length}] ${task.label} → crag=${result.scores.crag_score}` +
          `${recall === null ? "" : ` recall=${recall.toFixed(2)}`}`,
      );
    } catch (e) {
      failed++;
      console.error(
        `[${i + 1}/${tasks.length}] ${task.label} FAILED: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { succeeded, failed };
}

/** The identical closing summary both runners print. */
export function logRunSummary(written: number, failed: number, skipped: number): void {
  console.log(`\nDone. ${written} written, ${failed} failed, ${skipped} skipped.`);
}
