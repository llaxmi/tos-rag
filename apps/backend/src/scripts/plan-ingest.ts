import {
  CHUNKERS,
  assertOffsetInvariant,
  type Strategy,
  type TokenCounter,
} from "@tos-rag/core";

/**
 * The pure half of ingestion: canonical text in, database rows out.
 *
 * Split from ingest.ts so the part that has to be correct — offsets, token
 * counts, and the rule that stored text is never prefixed — is testable with
 * fake deps and no model, network, or database.
 */

export interface ChunkRow {
  doc_id: string;
  char_start: number;
  char_end: number;
  text: string;
  token_count: number;
  embedding: number[];
}

export interface PlanIngestDeps {
  countTokens: TokenCounter;
  /**
   * Document-side embedding. Applies the document prefix internally, and also
   * feeds the `semantic` chunker's breakpoint detection — so the raw `embed`
   * seam the Embedder interface deliberately avoids never surfaces here.
   */
  embedDocuments: (texts: string[]) => Promise<number[][]>;
}

/**
 * Asserts the chunker tiled the document: contiguous, gap-free, covering every
 * character exactly once. `assertOffsetInvariant` alone would pass on a chunker
 * that silently dropped a section, and a dropped section is unretrievable
 * without ever raising an error.
 */
function assertTiling(canonical: string, chunks: readonly { charStart: number; charEnd: number }[]): void {
  if (chunks.length === 0) {
    if (canonical.length > 0) throw new Error("Chunker returned no chunks for a non-empty document.");
    return;
  }
  if (chunks[0]!.charStart !== 0) {
    throw new Error(`First chunk starts at ${chunks[0]!.charStart}, expected 0.`);
  }
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i]!.charStart !== chunks[i - 1]!.charEnd) {
      throw new Error(
        `Gap or overlap between chunks ${i - 1} and ${i}: ` +
          `${chunks[i - 1]!.charEnd} → ${chunks[i]!.charStart}.`,
      );
    }
  }
  const last = chunks[chunks.length - 1]!;
  if (last.charEnd !== canonical.length) {
    throw new Error(`Last chunk ends at ${last.charEnd}, expected ${canonical.length}.`);
  }
}

export async function planIngest(
  canonical: string,
  docId: string,
  strategy: Strategy,
  chunkSize: number,
  deps: PlanIngestDeps,
): Promise<ChunkRow[]> {
  const chunks = await CHUNKERS[strategy](canonical, {
    maxTokens: chunkSize,
    countTokens: deps.countTokens,
    embed: deps.embedDocuments,
  });

  // Before any I/O: a violation here means every downstream offset is wrong.
  assertOffsetInvariant(canonical, chunks);
  assertTiling(canonical, chunks);

  for (const c of chunks) {
    if (c.tokenCount > chunkSize) {
      throw new Error(
        `Chunk [${c.charStart}, ${c.charEnd}) is ${c.tokenCount} tokens, over the ${chunkSize} budget.`,
      );
    }
  }

  // The embedder prefixes internally. What is passed here — and what is stored
  // below — is the raw canonical slice, unprefixed. Storing prefixed text would
  // break chunk.text === canonical.slice(charStart, charEnd).
  const embeddings = await deps.embedDocuments(chunks.map((c) => c.text));
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedder returned ${embeddings.length} vectors for ${chunks.length} chunks.`,
    );
  }

  return chunks.map((c, i) => ({
    doc_id: docId,
    char_start: c.charStart,
    char_end: c.charEnd,
    text: c.text,
    token_count: c.tokenCount,
    embedding: embeddings[i]!,
  }));
}
