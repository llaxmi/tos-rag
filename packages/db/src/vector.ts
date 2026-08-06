import { prisma } from "./client";

/** Row shape returned by the match_chunks exact-scan RPC (chunk_id omitted). */
export interface MatchedChunk {
  doc_id: string;
  char_start: number;
  char_end: number;
  text: string;
  score: number;
}

/** Chunk row to persist — mirrors the backend's plan-ingest ChunkRow. */
export interface ChunkRow {
  char_start: number;
  char_end: number;
  text: string;
  token_count: number;
  embedding: number[];
}

/** Postgres rejects very large multi-row inserts; batch the writes. */
const INSERT_BATCH = 200;

/**
 * Resolves a config's serial id by its (strategy, chunk_size) pair — never by a
 * hardcoded id, since ids are assigned in seed order. Throws with a seed hint if
 * the row is missing, which means `prisma db seed` hasn't run.
 */
export async function resolveConfigId(
  strategy: string,
  chunkSize: number,
): Promise<number> {
  const row = await prisma.configs.findUnique({
    where: { strategy_chunk_size: { strategy, chunk_size: chunkSize } },
    select: { id: true },
  });
  if (!row) {
    throw new Error(
      `No configs row for ${strategy} × ${chunkSize}: not found. ` +
        "Run `pnpm --filter @tos-rag/db exec prisma db seed`.",
    );
  }
  return row.id;
}

/**
 * Counts chunks ingested for a config id. `configs` rows are seeded
 * independently of ingestion (`prisma/seed.ts` seeds all 15 rows up front), so
 * `resolveConfigId` succeeding is not evidence the config has any chunks — a
 * winning config that was never ingested silently retrieves zero chunks per
 * question, and a caller that doesn't check this can write a full batch of
 * plausible-looking abstentions. Callers that are about to spend a run budget
 * on a config should assert this is non-zero before starting the loop, the
 * same "assert before I/O" discipline `plan-ingest.ts` uses for the offset
 * invariant.
 */
export async function countChunksForConfig(configId: number): Promise<number> {
  return prisma.chunks.count({ where: { config_id: configId } });
}

/**
 * pgvector text input format: a bracketed, comma-separated list with no spaces.
 * Number#toString may emit exponential notation for very small components
 * (e.g. `1e-7`); pgvector's parser accepts that form, so no reformatting is needed.
 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Exact-scan retrieval via the match_chunks RPC (PRD §8). Invoked through
 * Prisma raw SQL because `embedding` is an Unsupported column and pgvector ops
 * cannot go through the model API. Same k, same ordering, same 4 params as the
 * supabase.rpc call it replaces. The query vector is passed as a text literal
 * cast to ::vector — a bare array will not coerce.
 */
export async function matchChunks(
  configId: number,
  queryVector: number[],
  k: number,
  docId: string | null,
): Promise<MatchedChunk[]> {
  return prisma.$queryRaw<MatchedChunk[]>`
    select doc_id, char_start, char_end, text, score
    from match_chunks(
      ${configId}::int,
      ${toVectorLiteral(queryVector)}::vector,
      ${k}::int,
      ${docId}::text
    )
  `;
}

/**
 * Replace all chunks for a (config, doc) pair, then batch-insert the new rows.
 * Idempotent per pair — a re-run cannot double the corpus. Uses $executeRaw
 * because `embedding` is an Unsupported column (prisma.chunks.create cannot set
 * a required Unsupported field). Stored `text` is the raw canonical slice,
 * never prefixed (offset invariant).
 */
export async function insertChunks(
  configId: number,
  docId: string,
  rows: ChunkRow[],
): Promise<void> {
  await prisma.chunks.deleteMany({ where: { config_id: configId, doc_id: docId } });

  const { Prisma } = await import("@prisma/client");
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    // One multi-row INSERT per batch. Prisma.sql fragments compose via
    // Prisma.join; the embedding is cast from its text literal to ::vector.
    await prisma.$executeRaw(
      Prisma.sql`
        insert into chunks (config_id, doc_id, char_start, char_end, text, token_count, embedding)
        values ${Prisma.join(
          batch.map(
            (r) =>
              Prisma.sql`(${configId}, ${docId}, ${r.char_start}, ${r.char_end}, ${r.text}, ${r.token_count}, ${toVectorLiteral(
                r.embedding,
              )}::vector)`,
          ),
        )}
      `,
    );
  }
}
