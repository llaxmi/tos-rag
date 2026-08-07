/**
 * Compiles hand-authored questions into the ground-truth JSONL (PRD §6).
 *
 *   pnpm build-questions                 # both documents
 *   pnpm build-questions --doc netflix-tou
 *   pnpm build-questions --check         # validate only, write nothing
 *
 * Authors write corpus/questions/authoring/<doc_id>.yaml quoting evidence
 * verbatim; this turns each quote into canonical character offsets and emits
 * corpus/questions/<doc_id>.jsonl. The fragile offset math lives in
 * @tos-rag/core (buildQuestionRecords) so it is unit-tested without I/O; this
 * wrapper only does file reading, YAML parsing, the sha256-checked canonical
 * load, and writing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildQuestionRecords,
  DOC_IDS,
  QuoteResolutionError,
  type AuthoringEntry,
  type QuestionRecord,
} from "@tos-rag/core";
import { loadCanonical, REPO_ROOT } from "../adapters/canonical";
import { getFlag } from "./args";

const QUESTIONS_DIR = join(REPO_ROOT, "corpus", "questions");
const AUTHORING_DIR = join(QUESTIONS_DIR, "authoring");

interface Args {
  docIds: string[];
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const doc = getFlag(argv, "--doc");
  return {
    docIds: doc ? [doc] : [...DOC_IDS],
    check: argv.includes("--check"),
  };
}

function authoringPath(docId: string): string {
  return join(AUTHORING_DIR, `${docId}.yaml`);
}

function jsonlPath(docId: string): string {
  return join(QUESTIONS_DIR, `${docId}.jsonl`);
}

async function loadEntries(docId: string): Promise<AuthoringEntry[]> {
  const raw = await readFile(authoringPath(docId), "utf8");
  const parsed = parseYaml(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${authoringPath(docId)} must be a YAML list of questions.`);
  }
  return parsed as AuthoringEntry[];
}

function summarize(docId: string, records: QuestionRecord[]): string {
  const phase1 = records.filter((r) => r.phase1).length;
  const byType = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.qtype] = (acc[r.qtype] ?? 0) + 1;
    return acc;
  }, {});
  const types = Object.entries(byType)
    .map(([t, n]) => `${t}=${n}`)
    .join(", ");
  return `${docId}: ${records.length} questions (phase1=${phase1}, held-out=${records.length - phase1}) [${types}]`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seenIds = new Set<string>();
  const results: Array<{ docId: string; records: QuestionRecord[] }> = [];

  for (const docId of args.docIds) {
    const canonical = await loadCanonical(docId); // fails on sha256 drift (PRD §5)
    const entries = await loadEntries(docId);
    const records = buildQuestionRecords(docId, canonical.text, entries);

    for (const r of records) {
      if (seenIds.has(r.id)) {
        throw new QuoteResolutionError(`Duplicate id '${r.id}' across documents.`);
      }
      seenIds.add(r.id);
    }
    results.push({ docId, records });
    console.log(`✓ ${summarize(docId, records)}`);
  }

  if (args.check) {
    console.log(`\n✓ Validation passed for ${results.length} document(s). Nothing written (--check).`);
    return;
  }

  for (const { docId, records } of results) {
    const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(jsonlPath(docId), body, "utf8");
    console.log(`  wrote ${jsonlPath(docId)}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof QuoteResolutionError) {
    console.error(`\n✗ ${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
