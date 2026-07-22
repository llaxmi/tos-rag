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
 * re-run cannot silently double the corpus and fill k=8 with near-duplicates.
 */
import "dotenv/config";
import { insertChunks, prisma, resolveConfigId } from "@tos-rag/db";
import { CHUNK_SIZES, STRATEGIES, type Strategy } from "@tos-rag/core";
import { loadCanonical } from "../adapters/canonical";
import { createLocalEmbedder } from "../adapters/embedder.local";
import { planIngest } from "./plan-ingest";

interface Args {
  docId: string;
  configs: Array<{ strategy: Strategy; chunkSize: number }>;
  dtype?: "fp32" | "q8" | "q4";
  /** Chunk and embed, report, write nothing. Needs no database credentials. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

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

  const strategy = (get("--strategy") ?? "sentence") as Strategy;
  const chunkSize = Number(get("--size") ?? 256);
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown strategy '${strategy}'. One of: ${STRATEGIES.join(", ")}`);
  }
  if (!(CHUNK_SIZES as readonly number[]).includes(chunkSize)) {
    throw new Error(`Chunk size must be one of ${CHUNK_SIZES.join(", ")}, got ${chunkSize}`);
  }
  return { docId, dtype, dryRun, configs: [{ strategy, chunkSize }] };
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
    await prisma.documents.upsert({
      where: { id: canonical.docId },
      create: {
        id: canonical.docId,
        title: canonical.title,
        sha256: canonical.sha256,
        version: canonical.version,
        char_length: canonical.text.length,
      },
      update: {
        title: canonical.title,
        sha256: canonical.sha256,
        version: canonical.version,
        char_length: canonical.text.length,
      },
    });
  }

  const t0 = Date.now();
  const embedder = await createLocalEmbedder({ dtype: args.dtype });
  console.log(`embedder ${embedder.name} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  for (const { strategy, chunkSize } of args.configs) {
    const started = Date.now();
    const configId = args.dryRun ? null : await resolveConfigId(strategy, chunkSize);

    const rows = await planIngest(canonical.text, canonical.docId, strategy, chunkSize, {
      countTokens: embedder.countTokens,
      embedDocuments: embedder.embedDocuments,
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
