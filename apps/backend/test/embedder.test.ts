import { describe, expect, test } from "vitest";
import { EMBED_DIMS, EMBED_PREFIXES } from "@tos-rag/core";
import {
  assertVectors,
  batched,
  withDocumentPrefix,
  withQueryPrefix,
} from "../src/adapters/embedder";

const unit = (seed: number): number[] => {
  const v = Array.from({ length: EMBED_DIMS }, (_, i) => (i === seed % EMBED_DIMS ? 1 : 0));
  return v;
};

describe("prefixes", () => {
  test("query and document prefixes differ", () => {
    // EmbeddingGemma is trained asymmetrically. If these ever collapse to the
    // same string, retrieval quietly degrades with no other symptom.
    expect(EMBED_PREFIXES.query).not.toBe(EMBED_PREFIXES.document);
  });

  test("prefixes keep their trailing space", () => {
    // A trimmed prefix runs straight into the text ("...query: How much") and
    // no test other than this one would notice.
    expect(EMBED_PREFIXES.query).toBe("task: search result | query: ");
    expect(EMBED_PREFIXES.document).toBe("title: none | text: ");
    expect(EMBED_PREFIXES.query.endsWith(" ")).toBe(true);
    expect(EMBED_PREFIXES.document.endsWith(" ")).toBe(true);
  });

  test("helpers prepend without altering the payload", () => {
    expect(withQueryPrefix("abc")).toBe("task: search result | query: abc");
    expect(withDocumentPrefix("abc")).toBe("title: none | text: abc");
  });
});

describe("batched", () => {
  test("splits into fixed sizes preserving order", () => {
    expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("returns one batch when the input fits", () => {
    expect(batched([1, 2], 8)).toEqual([[1, 2]]);
  });

  test("handles empty input", () => {
    expect(batched([], 4)).toEqual([]);
  });

  test("rejects a zero batch size rather than looping forever", () => {
    expect(() => batched([1], 0)).toThrow(/>= 1/);
  });
});

describe("assertVectors", () => {
  const noop = () => {};

  test("passes unit vectors of the right width through untouched", () => {
    const v = unit(3);
    expect(assertVectors([v], noop)[0]).toEqual(v);
  });

  test("rejects the wrong dimensionality", () => {
    expect(() => assertVectors([[1, 0, 0]], noop)).toThrow(/expected 768/);
  });

  test("rejects the zero vector", () => {
    expect(() => assertVectors([new Array(EMBED_DIMS).fill(0)], noop)).toThrow(/zero vector/);
  });

  test("normalizes an un-normalized vector and warns", () => {
    const scaled = unit(1).map((x) => x * 5);
    let warned = "";
    const [out] = assertVectors([scaled], (m) => (warned = m));
    const norm = Math.sqrt(out!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(warned).toMatch(/L2 norm/);
  });
});
