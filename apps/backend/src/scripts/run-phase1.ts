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
 * real deps and owns the loop + persistence.
 */
import "dotenv/config";
import {
  CHUNK_SIZES,
  MODEL_IDS,
  planRuns,
  runOne,
  STRATEGIES,
  type OrchestratorDeps,
  type Strategy,
} from "@tos-rag/core";
import {
  getCompletedRunKeys,
  getQuestions,
  resolveConfigId,
  writeRun,
} from "@tos-rag/db";
import { createEmbedder, createJudge } from "../adapters";
import { createLiveDeps } from "../deps/live";

const PHASE = 1;
const MODEL = "llama" as const; // Phase 1 generator (PRD §7)

interface Args {
  only?: { strategy: Strategy; chunkSize: number };
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const configArg = get("--config");
  const limitArg = get("--limit");
  let only: Args["only"];
  if (configArg) {
    const [strategy, size] = configArg.split(":");
    only = { strategy: strategy as Strategy, chunkSize: Number(size) };
  }
  return { only, limit: limitArg ? Number(limitArg) : undefined };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL, ANTHROPIC_API_KEY, EMBEDDER, EMBEDDER_DTYPE, OLLAMA_URL, OLLAMA_MODEL } =
    process.env;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required (the CRAG judge).");

  const embedder = await createEmbedder({ EMBEDDER, EMBEDDER_DTYPE });
  const live = createLiveDeps(
    {
      OLLAMA_URL: OLLAMA_URL ?? "http://localhost:11434",
      OLLAMA_MODEL: OLLAMA_MODEL ?? "llama3.1:8b",
      ANTHROPIC_API_KEY,
    },
    embedder,
  );
  const deps: OrchestratorDeps = {
    retrieve: (q, opts) => live.retrieve(q, opts),
    generate: live.generate,
    judge: createJudge({ ANTHROPIC_API_KEY }),
  };

  // The 15-config grid (optionally restricted), resolved to config ids.
  const grid = args.only
    ? [args.only]
    : STRATEGIES.flatMap((strategy) =>
        CHUNK_SIZES.map((chunkSize) => ({ strategy, chunkSize })),
      );
  const configs = await Promise.all(
    grid.map(async (c) => ({ ...c, id: await resolveConfigId(c.strategy, c.chunkSize) })),
  );
  const byId = new Map(configs.map((c) => [c.id, c]));

  let questions = await getQuestions({ phase1: true });
  if (args.limit) questions = questions.slice(0, args.limit);
  const questionById = new Map(questions.map((q) => [q.id, q]));

  const done = await getCompletedRunKeys(PHASE, MODEL_IDS.llama);
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

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const { configId, questionId } = pending[i]!;
    const config = byId.get(configId)!;
    const question = questionById.get(questionId)!;
    const label = `${config.strategy}:${config.chunkSize} · ${questionId}`;
    try {
      const result = await runOne({ question, config, model: MODEL }, deps);
      await writeRun(
        {
          phase: PHASE,
          configId,
          model: MODEL_IDS.llama,
          questionId,
          retrieved: result.retrieved,
          answer: result.answer,
          retrievalMs: result.retrieval_ms,
          generationMs: result.generation_ms,
          inputTokens: result.input_tokens,
          outputTokens: result.output_tokens,
        },
        result.scores,
      );
      ok++;
      const recall = result.scores.char_recall;
      console.log(
        `[${i + 1}/${pending.length}] ${label} → crag=${result.scores.crag_score}` +
          `${recall === null ? "" : ` recall=${recall.toFixed(2)}`}` +
          `${result.retrieved.length === 0 ? "  ⚠ 0 chunks (config not ingested?)" : ""}`,
      );
    } catch (e) {
      failed++;
      console.error(`[${i + 1}/${pending.length}] ${label} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\nDone. ${ok} written, ${failed} failed, ${total - pending.length} skipped.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `\n✗ ${err.message}\n` : err);
  process.exitCode = 1;
});
