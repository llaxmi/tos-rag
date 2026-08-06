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

/**
 * The five chunking strategies under test (PRD §7). Single source of truth:
 * this is a frozen experimental control, so the backend zod schema, the ingest
 * validator, the config seed, and the demo grid all derive from this one tuple
 * rather than re-typing the list. `Strategy` is its element union.
 */
export const STRATEGIES = ["fixed", "recursive", "sentence", "semantic", "section"] as const;
export type Strategy = (typeof STRATEGIES)[number];

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

/** One generation call's result (PRD §8.6). */
export interface GenerationResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * The two generator arms (PRD §7): 'llama' = local Ollama, 'opus' = Anthropic.
 * Order matters: Phase-2 planning emits arms in this order, so Llama (free,
 * local) always runs before Opus (paid) — a `--limit` smoke run then surfaces
 * wiring faults before the paid arm spends anything.
 */
export const GENERATOR_MODELS = ["llama", "opus"] as const;
export type GeneratorModel = (typeof GENERATOR_MODELS)[number];
