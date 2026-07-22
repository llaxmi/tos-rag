/**
 * Fetches an upstream Terms of Service document and freezes it as canonical
 * text (PRD §5).
 *
 *   pnpm --filter backend exec tsx src/scripts/fetch-canonical.ts github-tos
 *
 * The output is the anchor for the whole experiment: every chunk boundary and
 * every gold clause span is a character offset into `corpus/canonical/<id>.md`.
 * Re-running this after annotation has begun will invalidate every span, which
 * is why loadCanonical() verifies sha256 on every read.
 *
 * `charLength` is recorded in UTF-16 code units (JS `String.length`), because
 * that is what `String.prototype.slice` — and therefore the offset invariant —
 * operates on. Postgres `length()` counts codepoints; never compare the two.
 */
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import {
  CANONICAL_DIR,
  canonicalPath,
  normalizeCanonical,
  recordCanonical,
} from "../adapters/canonical";

interface Source {
  title: string;
  url: string;
}

const SOURCES: Record<string, Source> = {
  "github-tos": {
    title: "GitHub Terms of Service",
    // Moved into Policies/github-terms/ upstream; the flat path in PRD §5 is a 404.
    url: "https://raw.githubusercontent.com/github/site-policy/main/Policies/github-terms/github-terms-of-service.md",
  },
  // 'netflix-tou' is deferred: it needs an HTML fetch, a turndown conversion,
  // and a hand-clean pass whose decisions go in corpus/canonical/CHANGELOG.md.
};

async function main(): Promise<void> {
  const docId = process.argv[2];
  if (!docId || !SOURCES[docId]) {
    console.error(
      `Usage: tsx src/scripts/fetch-canonical.ts <${Object.keys(SOURCES).join("|")}>`,
    );
    process.exit(1);
  }
  const source = SOURCES[docId]!;

  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${source.url}`);
  }
  const text = normalizeCanonical(await res.text());

  await mkdir(CANONICAL_DIR, { recursive: true });
  await writeFile(canonicalPath(docId), text, "utf8");
  const entry = await recordCanonical(docId, source.title, text);

  console.log(`wrote ${canonicalPath(docId)}`);
  console.log(`  sha256      ${entry.sha256}`);
  console.log(`  charLength  ${entry.charLength} (UTF-16 code units)`);
  console.log(`  version     ${entry.version}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
