import type {
  Chunk,
  ChunkerOptions,
  SemanticChunkerOptions,
  Strategy,
} from "../types";
import { cosineSimilarity } from "../metrics/cosine";
import {
  packByBudget,
  packUnits,
  sentenceRanges,
  splitRecursiveRange,
  toChunks,
} from "./internal";
import type { Range } from "../types";

/** Fixed-size: token-budget packing with no structural awareness. */
export function fixedChunker(text: string, opts: ChunkerOptions): Chunk[] {
  if (!text) return [];
  return toChunks(
    text,
    packByBudget(text, 0, text.length, opts.maxTokens, opts.countTokens),
    opts.countTokens,
  );
}

/** Recursive character splitting: paragraph → line → word hierarchy. */
export function recursiveChunker(text: string, opts: ChunkerOptions): Chunk[] {
  if (!text) return [];
  return toChunks(
    text,
    splitRecursiveRange(text, 0, text.length, 0, opts.maxTokens, opts.countTokens),
    opts.countTokens,
  );
}

/** Sentence-based: Intl.Segmenter sentences greedily packed into the budget. */
export function sentenceChunker(text: string, opts: ChunkerOptions): Chunk[] {
  if (!text) return [];
  return toChunks(
    text,
    packUnits(text, sentenceRanges(text), opts.maxTokens, opts.countTokens),
    opts.countTokens,
  );
}

/**
 * Semantic (LlamaIndex-style): breakpoints where adjacent-sentence embedding
 * distance exceeds the 95th percentile, then capped at the token budget.
 */
export async function semanticChunker(
  text: string,
  opts: SemanticChunkerOptions,
): Promise<Chunk[]> {
  if (!text) return [];
  const sentences = sentenceRanges(text);
  const runs: Range[][] = [];
  if (sentences.length <= 2) {
    runs.push(sentences);
  } else {
    const vectors = await opts.embed(sentences.map(([s, e]) => text.slice(s, e)));
    const distances: number[] = [];
    for (let i = 0; i < vectors.length - 1; i++) {
      distances.push(1 - cosineSimilarity(vectors[i]!, vectors[i + 1]!));
    }
    const sorted = [...distances].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
    const threshold = sorted[idx]!;
    let run: Range[] = [];
    for (let i = 0; i < sentences.length; i++) {
      run.push(sentences[i]!);
      if (i < distances.length && distances[i]! > threshold) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
  }
  const ranges = runs.flatMap((r) =>
    packUnits(text, r, opts.maxTokens, opts.countTokens),
  );
  return toChunks(text, ranges, opts.countTokens);
}

/**
 * Section-aware: chunks never cross Markdown heading boundaries; sections stay
 * whole unless oversized, then split recursively within the section.
 */
export function sectionChunker(text: string, opts: ChunkerOptions): Chunk[] {
  if (!text) return [];
  const starts = [0];
  for (const m of text.matchAll(/^#{1,6} /gm)) {
    if (m.index > 0) starts.push(m.index);
  }
  const ranges: Range[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const e = starts[i + 1] ?? text.length;
    if (s >= e) continue;
    if (opts.countTokens(text.slice(s, e)) <= opts.maxTokens) {
      ranges.push([s, e]);
    } else {
      ranges.push(
        ...splitRecursiveRange(text, s, e, 0, opts.maxTokens, opts.countTokens),
      );
    }
  }
  return toChunks(text, ranges, opts.countTokens);
}

/** Async-normalized registry over all five strategies (PRD §7). */
export const CHUNKERS: Record<
  Strategy,
  (text: string, opts: SemanticChunkerOptions) => Promise<Chunk[]>
> = {
  fixed: async (t, o) => fixedChunker(t, o),
  recursive: async (t, o) => recursiveChunker(t, o),
  sentence: async (t, o) => sentenceChunker(t, o),
  semantic: (t, o) => semanticChunker(t, o),
  section: async (t, o) => sectionChunker(t, o),
};

/**
 * PRD §8.3 offset invariant, asserted at ingestion on every chunk.
 * Throws if any chunk's text is not the exact canonical slice.
 */
export function assertOffsetInvariant(canonical: string, chunks: Chunk[]): void {
  for (const c of chunks) {
    if (c.text !== canonical.slice(c.charStart, c.charEnd)) {
      throw new Error(
        `Offset invariant violated at [${c.charStart}, ${c.charEnd})`,
      );
    }
  }
}
