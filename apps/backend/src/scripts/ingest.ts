/**
 * Chunks, embeds and stores one document under one or more configs (PRD §8).
 *
 *   pnpm ingest --doc github-tos --strategy sentence --size 256
 *   pnpm ingest --doc github-tos --all-configs        # the Phase 1 sweep
 *
 * Defaults to a single config: --all-configs runs 15 chunk+embed passes and
 * takes a long time, so it has to be asked for explicitly.
 *
 * Idempotent — rows for a (config, doc) pair are replaced, not appended, so a
 * re-run cannot silently double the corpus and fill the k results with near-duplicates.
 */
import "dotenv/config";
import { insertChunks, resolveConfigId, upsertDocument } from "@tos-rag/db";
import { CHUNK_SIZES, parseConfigRef, STRATEGIES, type Strategy } from "@tos-rag/core";
import { loadCanonical } from "../adapters/canonical";
import { createLocalEmbedder } from "../adapters/embedder.local";
import { getFlag } from "./args";
import { planIngest } from "./plan-ingest";

interface Args {
  docId: string;
  configs: Array<{ strategy: Strategy; chunkSize: number }>;
  dtype?: "fp32" | "q8" | "q4";
  /** Chunk and embed, report, write nothing. Needs no database credentials. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => getFlag(argv, flag);

  const docId = get("--doc") ?? "github-tos";
  const dtype = get("--dtype") as Args["dtype"];
  const dryRun = argv.includes("--dry-run");

  if (argv.includes("--all-configs")) {
    return {
      docId,
      dtype,
      dryRun,
      configs: STRATEGIES.flatMap((strategy) =>
        CHUNK_SIZES.map((chunkSize) => ({ strategy, chunkSize })),
      ),
    };
  }

  const config = parseConfigRef(`${get("--strategy") ?? "sentence"}:${get("--size") ?? 256}`);
  return { docId, dtype, dryRun, configs: [config] };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && !process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. See apps/backend/.env.example.\n" +
        "To validate chunking and embedding without a database, pass --dry-run.",
    );
  }
  if (args.dryRun) console.log("DRY RUN — nothing will be written\n");

  // Verifies sha256 against the manifest — refuses to ingest a document that
  // has drifted from the text its gold spans are anchored to (PRD §5).
  const canonical = await loadCanonical(args.docId);
  console.log(
    `${canonical.docId} v${canonical.version} — ${canonical.text.length} chars, sha256 ${canonical.sha256.slice(0, 12)}…`,
  );

  if (!args.dryRun) {
    await upsertDocument({
      id: canonical.docId,
      title: canonical.title,
      sha256: canonical.sha256,
      version: canonical.version,
      charLength: canonical.text.length,
    });
  }

  const t0 = Date.now();
  const embedder = await createLocalEmbedder({ dtype: args.dtype });
  console.log(`embedder ${embedder.name} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // The semantic chunker embeds every sentence to find its breakpoints, and the
  // sentence list does not depend on chunk size — so a `--all-configs` sweep
  // asks for the identical embeddings three times over. Cached by text for the
  // life of the run (the same trick `backfill-metrics.ts` uses); embeddings are
  // deterministic, so this changes cost, not output.
  const embedCache = new Map<string, number[]>();
  const embedDocuments = async (texts: string[]): Promise<number[][]> => {
    const missing = texts.filter((t) => !embedCache.has(t));
    if (missing.length > 0) {
      const fresh = await embedder.embedDocuments([...new Set(missing)]);
      [...new Set(missing)].forEach((t, i) => embedCache.set(t, fresh[i]!));
    }
    return texts.map((t) => embedCache.get(t)!);
  };

  for (const { strategy, chunkSize } of args.configs) {
    const started = Date.now();
    const configId = args.dryRun ? null : await resolveConfigId(strategy, chunkSize);

    const rows = await planIngest(canonical.text, canonical.docId, strategy, chunkSize, {
      countTokens: embedder.countTokens,
      embedDocuments,
    });

    if (configId !== null) {
      await insertChunks(configId, canonical.docId, rows);
    }

    const tokens = rows.map((r) => r.token_count);
    console.log(
      `${strategy} × ${chunkSize} (config ${configId ?? "dry-run"}): ${rows.length} chunks, ` +
        `tokens min ${Math.min(...tokens)} / median ${median(tokens)} / max ${Math.max(...tokens)}, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }
}

main().catch((e) => {
  console.error(`\ningest failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
