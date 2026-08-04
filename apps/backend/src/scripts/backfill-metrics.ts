/**
 * Fills the three `evals` columns the evaluator left NULL — `faithfulness`,
 * `cosine_sim`, `cost_usd` (PRD §10.2, §10.5) — over the 360 collected runs.
 *
 *   pnpm backfill-metrics                     # dry run: print the plan, write nothing
 *   pnpm backfill-metrics --apply             # write
 *   pnpm backfill-metrics --phase 2 --apply   # one phase (Phase 2 first — 1/5 the cost)
 *   pnpm backfill-metrics --metric cosine     # one metric (cosine is free)
 *   pnpm backfill-metrics --force --apply     # recompute rows that already have a value
 *
 * No run is regenerated — every value comes from stored data. Only those three
 * columns are written, never `runs` and never `crag_score`.
 *
 * Resumable: a row that already has a value is skipped, so an interrupted run
 * picks up where it stopped and a finished one costs $0. Anthropic returned
 * sustained 529s while Phase 2 was collected, so stopping part-way is normal.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  cosineSimilarity,
  costUsd,
  isAbstention,
  reconstructContext,
  scoreFaithfulness,
} from "@tos-rag/core";
import {
  getBackfillRows,
  getDocumentSha256,
  prisma,
  updateEvalMetrics,
  type BackfillRow,
} from "@tos-rag/db";
import { createEmbedder, createJudge, loadCanonical } from "../adapters";
import { ALL_METRICS, parseBackfillArgs, type MetricName } from "./args";

/**
 * Rough cost of one faithfulness row — two Sonnet calls over a ~3k-token
 * context (PRD §7). Printed before spending: an estimate, not a bill.
 */
const FAITHFULNESS_USD_PER_ROW = 0.013;

/**
 * Room for a full statement or verdict list. 2048 was too tight — one long Opus
 * answer decomposed into 32 statements and hit the cap — and a truncated reply
 * is unparseable, so it costs a failed row.
 */
const FAITHFULNESS_MAX_TOKENS = 4096;

/** Keyed by the same names `--metric` takes. */
export type Todo = Record<MetricName, BackfillRow[]>;

/**
 * Which rows each metric still owes.
 *
 * `cost` is Phase-2 only: Phase 1 runs on local Llama, so its cost is always $0.
 * Left NULL rather than written as 0, so "not applicable" cannot be misread as
 * "measured as free".
 *
 * Abstentions are dropped from `faithfulness` here, so they never enter the work
 * list and the printed estimate matches the real spend.
 */
export function planWork(
  rows: readonly BackfillRow[],
  args: { force: boolean; metrics: MetricName[] },
): Todo {
  const want = (m: MetricName) => args.metrics.includes(m);
  const pending = (current: number | null) => args.force || current === null;
  return {
    faithfulness: want("faithfulness")
      ? rows.filter((r) => pending(r.faithfulness) && !isAbstention(r.answer))
      : [],
    cosine: want("cosine") ? rows.filter((r) => pending(r.cosineSim)) : [],
    cost: want("cost") ? rows.filter((r) => r.phase === 2 && pending(r.costUsd)) : [],
  };
}

/** The API key is needed only when this run will actually call the judge. */
export function requireJudgeKey(
  args: { apply: boolean },
  todo: Pick<Todo, "faithfulness">,
  apiKey: string | undefined,
): void {
  if (args.apply && todo.faithfulness.length > 0 && !apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the faithfulness judge.");
  }
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

  const rows = await getBackfillRows({ phase: args.phase });
  const todo = planWork(rows, args);
  requireJudgeKey(args, todo, process.env.ANTHROPIC_API_KEY);
  const abstentions = rows.filter((r) => isAbstention(r.answer)).length;

  console.log(
    `Backfill over ${rows.length} run(s)` +
      `${args.phase ? ` (phase ${args.phase})` : ""}` +
      `${args.metrics.length < ALL_METRICS.length ? ` · metrics: ${args.metrics.join(", ")}` : ""}` +
      `${args.force ? " · --force (recomputing stored values)" : ""}`,
  );
  console.log(`  faithfulness  ${todo.faithfulness.length} to do (${abstentions} abstentions stay NULL)`);
  console.log(`  cosine_sim    ${todo.cosine.length} to do`);
  console.log(`  cost_usd      ${todo.cost.length} to do (phase 2 only)`);
  console.log(
    `  estimated spend ≈ $${(todo.faithfulness.length * FAITHFULNESS_USD_PER_ROW).toFixed(2)} ` +
      "(faithfulness only; cosine and cost call no paid model)",
  );

  if (!args.apply) {
    console.log("\nDry run. Re-run with --apply to write these values.");
    return;
  }
  const total = todo.faithfulness.length + todo.cosine.length + todo.cost.length;
  if (total === 0) {
    console.log("\nNothing to do.");
    return;
  }

  let written = 0;
  let failed = 0;
  let noStatements = 0;

  // --- cost: arithmetic on stored tokens, no service needed ---------------
  failed += await eachRow("cost", todo.cost, async (row) => {
    if (row.inputTokens === null || row.outputTokens === null) {
      throw new Error("token counts are NULL — cannot price this run");
    }
    await updateEvalMetrics(row.runId, {
      cost_usd: costUsd(row.model, row.inputTokens, row.outputTokens),
    });
    written++;
  });

  // --- cosine: local embedder, no paid call -------------------------------
  if (todo.cosine.length > 0) {
    const embedder = await createEmbedder(process.env);
    // Cached: the same texts repeat a lot. Phase 1 is 15 configs × the same 20
    // questions, so each expected answer would otherwise be embedded 15 times.
    // Over the 360 runs that is ~245 distinct texts instead of 720.
    const vectors = new Map<string, number[]>();
    const embed = async (texts: readonly string[]): Promise<number[][]> => {
      const missing = [...new Set(texts.filter((t) => !vectors.has(t)))];
      if (missing.length > 0) {
        // Both sides use embedDocuments. This compares an answer to an answer,
        // and the query prefix would read as a meaning difference when it is
        // only a prefix difference.
        const embedded = await embedder.embedDocuments(missing);
        missing.forEach((t, i) => vectors.set(t, embedded[i]!));
      }
      return texts.map((t) => vectors.get(t)!);
    };
    failed += await eachRow("cosine", todo.cosine, async (row, i) => {
      const [got, want] = await embed([row.answer, row.expectedAnswer]);
      await updateEvalMetrics(row.runId, { cosine_sim: cosineSimilarity(got!, want!) });
      written++;
      if ((i + 1) % 50 === 0) console.log(`  cosine ${i + 1}/${todo.cosine.length}`);
    });
  }

  // --- faithfulness: two Sonnet calls per row, the only spend -------------
  if (todo.faithfulness.length > 0) {
    const judge = createJudge(
      { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      FAITHFULNESS_MAX_TOKENS,
    );
    const canonicals = await loadCanonicalsAsIngested(todo.faithfulness);
    failed += await eachRow("faithfulness", todo.faithfulness, async (row, i) => {
      const context = reconstructContext(row.retrieved, canonicals);
      const result = await scoreFaithfulness(
        { question: row.question, answer: row.answer, context },
        { judge },
      );
      if (result.score === null) {
        // Only "no-statements" reaches here; abstentions never entered the work
        // list. Left NULL and counted separately: an answer with nothing to
        // check is not the same as one that failed to score, and any number
        // written here would be a measurement that was never taken.
        noStatements++;
        console.log(`  run ${row.runId} (${row.questionId}) decomposed to 0 statements — left NULL`);
        return;
      }
      await updateEvalMetrics(row.runId, { faithfulness: result.score });
      written++;
      console.log(
        `  [${i + 1}/${todo.faithfulness.length}] run ${row.runId} ${row.questionId} → ` +
          `${result.supported}/${result.total} = ${result.score.toFixed(3)}`,
      );
    });
  }

  console.log(
    `\nDone. ${written} value(s) written, ${failed} failed, ` +
      `${noStatements} left NULL (zero statements).`,
  );
  if (noStatements > 0) {
    // `planWork` cannot tell "nothing to check" from "not attempted yet" — both
    // are NULL, on purpose, so NULL keeps one meaning. The price is that these
    // rows are re-selected and pay for one decompose call on every future run.
    console.log(
      `  ${noStatements} row(s) left NULL because the answer had nothing to check — ` +
        "these will be re-attempted (and re-billed for one decompose call each) on every future run.",
    );
  }
  // A partial backfill must not read as a complete one.
  if (failed > 0) process.exitCode = 1;
}

/**
 * The loop all three metrics share: one row at a time, a failure logged and
 * counted instead of stopping the backfill (re-running is the retry). Returns
 * the failure count; `work` decides what counts as written for its metric.
 */
async function eachRow(
  metric: MetricName,
  rows: readonly BackfillRow[],
  work: (row: BackfillRow, i: number) => Promise<void>,
): Promise<number> {
  let failed = 0;
  for (const [i, row] of rows.entries()) {
    try {
      await work(row, i);
    } catch (e) {
      failed++;
      logFailure(metric, row, e);
    }
  }
  return failed;
}

/**
 * The canonical text of every document these rows retrieved from — one load per
 * document, not per row.
 *
 * Keyed on the doc ids in `retrieved`, not the questions' own: retrieval
 * searches the whole corpus, so a question about one document can legitimately
 * retrieve chunks from another.
 *
 * Both sha256 checks are needed. `loadCanonical` compares the file on disk to
 * `manifest.json`, but a re-fetch that also re-froze the manifest would pass
 * that while every stored span points at different text. `documents.sha256`,
 * written at ingest time, is the real baseline — so a corpus edit since
 * collection crashes here instead of scoring against text the run never saw.
 */
async function loadCanonicalsAsIngested(
  rows: readonly BackfillRow[],
): Promise<Map<string, string>> {
  const canonicals = new Map<string, string>();
  for (const docId of new Set(rows.flatMap((r) => r.retrieved.map((x) => x.doc_id)))) {
    const canonical = await loadCanonical(docId);
    const ingestedSha256 = await getDocumentSha256(docId);
    if (ingestedSha256 === null) {
      throw new Error(
        `No 'documents' row for '${docId}' — cannot verify the canonical on disk still ` +
          "matches what was ingested. Has this document been ingested?",
      );
    }
    if (ingestedSha256 !== canonical.sha256) {
      throw new Error(
        `Canonical '${docId}' on disk (sha256 ${canonical.sha256.slice(0, 12)}…) does not ` +
          `match the sha256 recorded in 'documents' at ingest time ` +
          `(${ingestedSha256.slice(0, 12)}…). The manifest was re-frozen since ingest, and ` +
          "every stored span for this document now points at different text than what is on disk.",
      );
    }
    canonicals.set(docId, canonical.text);
  }
  return canonicals;
}

function logFailure(metric: MetricName, row: BackfillRow, e: unknown): void {
  console.error(
    `  ${metric} FAILED run ${row.runId} (${row.model} · ${row.questionId}): ` +
      `${e instanceof Error ? e.message : String(e)}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
