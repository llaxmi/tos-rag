/**
 * Freezes a HAND-AUTHORED canonical document (PRD §5).
 *
 *   pnpm --filter backend exec tsx src/scripts/freeze-canonical.ts netflix-tou "Netflix Terms of Use"
 *
 * Unlike fetch-canonical (which pulls a URL), this takes an existing
 * corpus/canonical/<id>.md produced by hand — e.g. a PDF transcription —
 * normalizes it in place so the file on disk equals its canonical form, and
 * records its sha256 in manifest.json (+ checksums.txt). Re-running after
 * gold-span annotation has begun invalidates every span, which is why
 * loadCanonical verifies sha256 on every read.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalPath,
  normalizeCanonical,
  recordCanonical,
} from "../adapters/canonical";

async function main(): Promise<void> {
  const docId = process.argv[2];
  const title = process.argv[3];
  if (!docId || !title) {
    console.error('Usage: tsx src/scripts/freeze-canonical.ts <doc-id> "<title>"');
    process.exit(1);
  }

  const path = canonicalPath(docId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`${path} does not exist. Author it first, then freeze.`);
  }

  const text = normalizeCanonical(raw);
  await writeFile(path, text, "utf8"); // file on disk == normalized form
  const entry = await recordCanonical(docId, title, text);

  console.log(`froze ${path}`);
  console.log(`  sha256      ${entry.sha256}`);
  console.log(`  charLength  ${entry.charLength} (UTF-16 code units)`);
  console.log(`  version     ${entry.version}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
