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
