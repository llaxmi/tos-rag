/**
 * Seeds the ground-truth questions into the database (PRD §6, §9).
 *
 *   pnpm seed-questions                 # both documents
 *   pnpm seed-questions --doc netflix-tou
 *   pnpm seed-questions --dry-run       # validate only, no DB needed
 *
 * Idempotent and self-sufficient: ensures each referenced `documents` row exists
 * (upserted from the sha256-verified canonical, PRD §5) before upserting the
 * questions, so it can run without `ingest` and cannot hit a foreign-key error.
 *
 * The fragile part (JSONL schema conformance) lives in @tos-rag/core
 * (parseQuestionsJsonl) and is unit-tested; this wrapper does file I/O and the
 * Prisma upserts.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseQuestionsJsonl } from "@tos-rag/core";
import { upsertDocument, upsertQuestions } from "@tos-rag/db";
import { loadCanonical, REPO_ROOT } from "../adapters/canonical";

const DOC_IDS = ["github-tos", "netflix-tou"] as const;
const QUESTIONS_DIR = join(REPO_ROOT, "corpus", "questions");

interface Args {
  docIds: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const i = argv.indexOf("--doc");
  const doc = i === -1 ? undefined : argv[i + 1];
  return {
    docIds: doc ? [doc] : [...DOC_IDS],
    dryRun: argv.includes("--dry-run"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required to seed. Pass --dry-run to validate the JSONL without a database.",
    );
  }
  if (args.dryRun) console.log("DRY RUN — validating only, nothing written\n");

  for (const docId of args.docIds) {
    const canonical = await loadCanonical(docId); // sha256-verified (PRD §5)
    const text = await readFile(join(QUESTIONS_DIR, `${docId}.jsonl`), "utf8");
    const records = parseQuestionsJsonl(text);
    const phase1 = records.filter((r) => r.phase1).length;

    if (args.dryRun) {
      console.log(
        `✓ ${docId}: ${records.length} questions parse (phase1=${phase1}, held-out=${records.length - phase1})`,
      );
      continue;
    }

    await upsertDocument({
      id: canonical.docId,
      title: canonical.title,
      sha256: canonical.sha256,
      version: canonical.version,
      charLength: canonical.text.length,
    });
    const n = await upsertQuestions(records);
    console.log(
      `✓ ${docId}: document ok; ${n} questions upserted (phase1=${phase1}, held-out=${records.length - phase1})`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `\n✗ ${err.message}\n` : err);
  process.exitCode = 1;
});
