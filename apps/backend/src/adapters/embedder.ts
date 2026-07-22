import { EMBED_DIMS, EMBED_PREFIXES, type TokenCounter } from "@tos-rag/core";

/**
 * The embedding surface (PRD §8.2/§8.4).
 *
 * Note what is NOT here: there is no raw `embed(texts)`. EmbeddingGemma uses
 * different prompt prefixes for queries and documents, and getting that wrong
 * degrades retrieval with no error and no symptom other than mediocre results.
 * Exposing only the two intent-named methods means neither call site can pick
 * the wrong prefix — the choice is made by which method you call.
 */
export interface Embedder {
  /** Label for logs, so it is never ambiguous which pipeline produced an answer. */
  readonly name: string;
  /** The embedder's own tokenizer — the measuring stick for chunk size (PRD §8.2). */
  countTokens: TokenCounter;
  embedQuery: (text: string) => Promise<number[]>;
  embedDocuments: (texts: string[]) => Promise<number[][]>;
}

export const withQueryPrefix = (text: string): string =>
  `${EMBED_PREFIXES.query}${text}`;

export const withDocumentPrefix = (text: string): string =>
  `${EMBED_PREFIXES.document}${text}`;

/** Splits into fixed-size batches, preserving order. */
export function batched<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`Batch size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Guards the two things that silently corrupt a vector store: wrong width, and
 * vectors that aren't unit length (cosine via `<=>` assumes they are).
 * Normalizes rather than throwing on the latter, per PRD §8.4, but says so.
 */
export function assertVectors(vectors: number[][], warn: (m: string) => void): number[][] {
  return vectors.map((v, i) => {
    if (v.length !== EMBED_DIMS) {
      throw new Error(
        `Embedding ${i} has ${v.length} dimensions, expected ${EMBED_DIMS}. ` +
          `The chunks table stores vector(${EMBED_DIMS}); a mismatch here means the wrong model.`,
      );
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) {
      throw new Error(`Embedding ${i} is the zero vector — cosine is undefined.`);
    }
    if (Math.abs(norm - 1) > 1e-3) {
      warn(`Embedding ${i} had L2 norm ${norm.toFixed(6)}; normalizing.`);
      return v.map((x) => x / norm);
    }
    return v;
  });
}

/** Warns once per process for a given key, so a batch of 70 doesn't print 70 lines. */
export function warnOnce(): (message: string) => void {
  let warned = false;
  return (message: string) => {
    if (warned) return;
    warned = true;
    console.warn(`[embedder] ${message} (further warnings suppressed)`);
  };
}
