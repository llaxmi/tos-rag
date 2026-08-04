import { prisma } from "./client";

/** A `documents` row (PRD §9), sourced from a verified canonical (PRD §5). */
export interface DocumentRow {
  id: string;
  title: string;
  sha256: string;
  version: number;
  charLength: number;
}

/**
 * Idempotently upserts a document row. Shared by `ingest` and `seed-questions`
 * so the `documents` upsert lives in exactly one place and the two cannot drift.
 */
export async function upsertDocument(doc: DocumentRow): Promise<void> {
  const data = {
    title: doc.title,
    sha256: doc.sha256,
    version: doc.version,
    char_length: doc.charLength,
  };
  await prisma.documents.upsert({
    where: { id: doc.id },
    create: { id: doc.id, ...data },
    update: data,
  });
}

/**
 * The sha256 `upsertDocument` wrote at ingest time, or `null` if the document
 * has no row. `loadCanonical` only checks the file on disk against
 * `manifest.json`, so a re-fetch that also re-froze the manifest would pass it
 * while every stored span points at different text. This column is the baseline
 * that catches that.
 */
export async function getDocumentSha256(docId: string): Promise<string | null> {
  const doc = await prisma.documents.findUnique({
    where: { id: docId },
    select: { sha256: true },
  });
  return doc?.sha256 ?? null;
}
