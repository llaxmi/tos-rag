import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Canonical document loader (PRD §8.1).
 *
 * Every chunk boundary and every gold clause span in the experiment is a
 * character offset into these files, so they are frozen once annotation starts
 * (PRD §5). `loadCanonical` refuses to hand back a document whose sha256 has
 * drifted from the manifest — that mismatch means every span recorded against
 * it is now pointing at the wrong text, and failing loudly is the only safe
 * response.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/backend/src/adapters → repo root */
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const CANONICAL_DIR = join(REPO_ROOT, "corpus", "canonical");

const MANIFEST = join(CANONICAL_DIR, "manifest.json");
const CHECKSUMS = join(CANONICAL_DIR, "checksums.txt");

export interface CanonicalDoc {
  docId: string;
  text: string;
  sha256: string;
  version: number;
  title: string;
}

export interface ManifestEntry {
  title: string;
  sha256: string;
  version: number;
  /**
   * `text.length` in UTF-16 code units — what String.prototype.slice operates
   * on, and therefore the unit the offset invariant is defined in. Postgres
   * `length()` counts codepoints and will disagree on any astral character;
   * never cross-check the two.
   */
  charLength: number;
}

export type Manifest = Record<string, ManifestEntry>;

/**
 * Turns an upstream Markdown source into canonical text (PRD §5).
 *
 * Deliberately minimal: front-matter, lint pragmas, line endings, trailing
 * whitespace. Nothing that rewrites prose. Every edit here shifts every
 * character offset downstream, so this function is effectively frozen once
 * gold-span annotation begins.
 */
export function normalizeCanonical(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    // YAML front-matter block, only when it opens the file.
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    // markdownlint pragmas: publishing-tool directives, not part of the terms.
    .replace(/^<!-- markdownlint-(?:disable|enable)[^\n]*-->\n/gm, "")
    // Leading blank lines left behind by the two strips above, so offset 0 is
    // the first real character of the document.
    .replace(/^\n+/, "")
    .replace(/\s+$/, "")
    .concat("\n");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalPath(docId: string): string {
  return join(CANONICAL_DIR, `${docId}.md`);
}

export async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

/**
 * Writes the manifest and regenerates checksums.txt from it, so the two can
 * never drift. checksums.txt is `sha256sum -c` compatible and exists because
 * PRD §5 names it as the CI gate.
 */
export async function writeManifest(manifest: Manifest): Promise<void> {
  const ordered = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(MANIFEST, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  const lines = Object.entries(ordered).map(
    ([docId, e]) => `${e.sha256}  ${docId}.md`,
  );
  await writeFile(CHECKSUMS, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Records a canonical document in the manifest (+ checksums.txt) and returns its
 * entry (PRD §5 freeze protocol). Shared by fetch-canonical and freeze-canonical
 * so the version-bump rule and its drift warning live in exactly one place: a
 * changed sha256 against a prior freeze warns loudly and bumps the version,
 * because every gold span and ingested chunk is now anchored to the wrong text.
 * The caller is responsible for having already written the normalized text to
 * `canonicalPath(docId)`.
 */
export async function recordCanonical(
  docId: string,
  title: string,
  text: string,
): Promise<ManifestEntry> {
  const digest = sha256(text);
  const manifest = await readManifest();
  const prior = manifest[docId];
  const changed = prior !== undefined && prior.sha256 !== digest;
  if (changed) {
    console.warn(
      `\n!!  '${docId}' was already frozen with a DIFFERENT sha256.\n` +
        `    was ${prior.sha256}\n    now ${digest}\n` +
        `    Upstream (or the source file) changed. Every gold span and every\n` +
        `    ingested chunk for this document is now anchored to the wrong text.\n` +
        `    Writing version ${prior.version + 1}; re-annotate, or restore the file.\n`,
    );
  }
  const entry: ManifestEntry = {
    title,
    sha256: digest,
    version: changed ? prior.version + 1 : (prior?.version ?? 1),
    charLength: text.length,
  };
  manifest[docId] = entry;
  await writeManifest(manifest);
  return entry;
}

export async function loadCanonical(docId: string): Promise<CanonicalDoc> {
  const manifest = await readManifest();
  const entry = manifest[docId];
  if (!entry) {
    throw new Error(
      `No canonical document '${docId}'. Run: pnpm --filter backend exec tsx src/scripts/fetch-canonical.ts ${docId}`,
    );
  }

  let text: string;
  try {
    text = await readFile(canonicalPath(docId), "utf8");
  } catch {
    throw new Error(
      `${canonicalPath(docId)} is missing but listed in manifest.json — re-fetch it.`,
    );
  }

  const actual = sha256(text);
  if (actual !== entry.sha256) {
    throw new Error(
      `Canonical document '${docId}' has changed since it was frozen (PRD §5).\n` +
        `  expected sha256 ${entry.sha256}\n` +
        `  actual   sha256 ${actual}\n` +
        `Every chunk offset and gold span recorded against this document is now invalid. ` +
        `Either restore the original file, or bump its version and re-annotate.`,
    );
  }

  return {
    docId,
    text,
    sha256: actual,
    version: entry.version,
    title: entry.title,
  };
}
