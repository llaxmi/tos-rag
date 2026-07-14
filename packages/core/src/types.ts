/** Counts tokens in the embedder's own tokenizer (PRD §8.2). Injected so tests stay hermetic. */
export type TokenCounter = (text: string) => number;

/** Embeds a batch of texts (≤100 per call at ingestion). Injected dependency. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * A chunk of a canonical document (PRD §8.3).
 * Invariant: text === canonical.slice(charStart, charEnd)
 */
export interface Chunk {
  charStart: number;
  charEnd: number;
  text: string;
  tokenCount: number;
}

export interface ChunkerOptions {
  maxTokens: number;
  countTokens: TokenCounter;
}

export interface SemanticChunkerOptions extends ChunkerOptions {
  embed: EmbedFn;
}

export type Strategy = "fixed" | "recursive" | "sentence" | "semantic" | "section";

/** A character span within a canonical document. */
export interface Span {
  charStart: number;
  charEnd: number;
}

/** A span tagged with the document it belongs to. */
export interface DocSpan extends Span {
  docId: string;
}

/** A retrieved chunk as passed to the generation prompt / demo evidence panel. */
export interface RetrievedChunk extends DocSpan {
  text: string;
  score: number;
}

/** Half-open range [start, end) into a string. */
export type Range = [number, number];
