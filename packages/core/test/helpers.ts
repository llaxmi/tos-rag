import { expect } from "vitest";
import type { Chunk, TokenCounter } from "../src/index";

/** Deterministic fake tokenizer: 1 token per whitespace-delimited word. */
export const wordCounter: TokenCounter = (text) =>
  text.split(/\s+/).filter(Boolean).length;

/** Deterministic fake tokenizer: ~1 token per 4 characters. */
export const charCounter: TokenCounter = (text) => Math.ceil(text.length / 4);

/** Deterministic fake embedder: maps each text to a small vector derived from its chars. */
export async function fakeEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < t.length; i++) {
      const idx = t.charCodeAt(i) % 4;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}

/**
 * The PRD §8.3 chunker contract:
 *  - offset invariant: text === canonical.slice(charStart, charEnd)
 *  - full tiling: chunks are contiguous, start at 0, end at canonical.length
 *  - token budget respected
 */
export function assertChunkInvariants(
  canonical: string,
  chunks: Chunk[],
  maxTokens: number,
  countTokens: TokenCounter,
): void {
  if (canonical.length === 0) {
    expect(chunks).toEqual([]);
    return;
  }
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.charStart).toBe(0);
  expect(chunks[chunks.length - 1]!.charEnd).toBe(canonical.length);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    expect(c.text).toBe(canonical.slice(c.charStart, c.charEnd));
    expect(c.charEnd).toBeGreaterThan(c.charStart);
    expect(c.tokenCount).toBe(countTokens(c.text));
    expect(c.tokenCount).toBeLessThanOrEqual(maxTokens);
    if (i > 0) expect(c.charStart).toBe(chunks[i - 1]!.charEnd);
  }
}
