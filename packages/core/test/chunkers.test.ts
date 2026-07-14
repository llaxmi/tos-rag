import { describe, expect, test } from "vitest";
import {
  fixedChunker,
  recursiveChunker,
  sectionChunker,
  semanticChunker,
  sentenceChunker,
} from "../src/index";
import {
  assertChunkInvariants,
  charCounter,
  fakeEmbed,
  wordCounter,
} from "./helpers";

const PARAGRAPHS = [
  "GitHub provides hosting for software development. You must be 13 years or older to use the Service.",
  "We may terminate your access at any time. Fees are due 30 days after the invoice date.",
  "This Agreement is governed by California law. Disputes go to arbitration first.",
].join("\n\n");

const MARKDOWN_DOC = [
  "# Terms of Service",
  "",
  "Welcome to the service. These terms govern your use.",
  "",
  "## A. Definitions",
  "",
  'The "Service" means the hosted platform. The "User" means you, the account holder acting individually.',
  "",
  "## B. Payment",
  "",
  "Fees are due monthly. We will give at least 30 days notice before changing fees. Refunds are not provided for partial months of service.",
].join("\n");

describe("fixedChunker", () => {
  test("packs text into token-budget slices that tile the document", () => {
    const chunks = fixedChunker(PARAGRAPHS, {
      maxTokens: 12,
      countTokens: wordCounter,
    });
    assertChunkInvariants(PARAGRAPHS, chunks, 12, wordCounter);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("returns empty array for empty text", () => {
    expect(
      fixedChunker("", { maxTokens: 10, countTokens: wordCounter }),
    ).toEqual([]);
  });

  test("splits mid-word when a single word exceeds the budget", () => {
    const text = "supercalifragilisticexpialidocious";
    const chunks = fixedChunker(text, { maxTokens: 2, countTokens: charCounter });
    assertChunkInvariants(text, chunks, 2, charCounter);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("prefers whitespace boundaries when available", () => {
    const chunks = fixedChunker(PARAGRAPHS, {
      maxTokens: 12,
      countTokens: wordCounter,
    });
    // every chunk except the last should end at a whitespace boundary
    for (const c of chunks.slice(0, -1)) {
      const boundary = PARAGRAPHS[c.charEnd - 1] ?? "";
      const next = PARAGRAPHS[c.charEnd] ?? "";
      expect(/\s/.test(boundary) || /\s/.test(next)).toBe(true);
    }
  });
});

describe("recursiveChunker", () => {
  test("respects paragraph boundaries when they fit the budget", () => {
    const chunks = recursiveChunker(PARAGRAPHS, {
      maxTokens: 20,
      countTokens: wordCounter,
    });
    assertChunkInvariants(PARAGRAPHS, chunks, 20, wordCounter);
    // each paragraph is <= 20 words, so no chunk should straddle a "\n\n" break
    for (const c of chunks) {
      expect(c.text.trim()).not.toContain("\n\n");
    }
  });

  test("falls through separator hierarchy for oversized paragraphs", () => {
    const chunks = recursiveChunker(PARAGRAPHS, {
      maxTokens: 8,
      countTokens: wordCounter,
    });
    assertChunkInvariants(PARAGRAPHS, chunks, 8, wordCounter);
  });

  test("returns empty array for empty text", () => {
    expect(
      recursiveChunker("", { maxTokens: 10, countTokens: wordCounter }),
    ).toEqual([]);
  });
});

describe("sentenceChunker", () => {
  test("packs whole sentences and tiles the document", () => {
    const chunks = sentenceChunker(PARAGRAPHS, {
      maxTokens: 20,
      countTokens: wordCounter,
    });
    assertChunkInvariants(PARAGRAPHS, chunks, 20, wordCounter);
    // chunks should end at sentence boundaries (a period, possibly + whitespace)
    for (const c of chunks.slice(0, -1)) {
      expect(c.text.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  test("does not break after common abbreviations", () => {
    const text = "See Sec. 4 for details e.g. the fee schedule. Another sentence here.";
    const chunks = sentenceChunker(text, {
      maxTokens: 12,
      countTokens: wordCounter,
    });
    assertChunkInvariants(text, chunks, 12, wordCounter);
    // "Sec." and "e.g." must not terminate a chunk
    for (const c of chunks) {
      expect(c.text.trimEnd()).not.toMatch(/\b(Sec|e\.g)\.$/);
    }
  });

  test("splits an oversized single sentence rather than exceeding budget", () => {
    const long =
      "This single sentence just keeps going with many many words far beyond any small budget limit here.";
    const chunks = sentenceChunker(long, {
      maxTokens: 5,
      countTokens: wordCounter,
    });
    assertChunkInvariants(long, chunks, 5, wordCounter);
    expect(chunks.length).toBeGreaterThan(2);
  });
});

describe("semanticChunker", () => {
  test("tiles the document and respects the token budget", async () => {
    const chunks = await semanticChunker(PARAGRAPHS, {
      maxTokens: 20,
      countTokens: wordCounter,
      embed: fakeEmbed,
    });
    assertChunkInvariants(PARAGRAPHS, chunks, 20, wordCounter);
  });

  test("places breakpoints only at sentence boundaries", async () => {
    const chunks = await semanticChunker(PARAGRAPHS, {
      maxTokens: 50,
      countTokens: wordCounter,
      embed: fakeEmbed,
    });
    for (const c of chunks.slice(0, -1)) {
      expect(c.text.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  test("handles single-sentence documents", async () => {
    const text = "Only one sentence lives here.";
    const chunks = await semanticChunker(text, {
      maxTokens: 20,
      countTokens: wordCounter,
      embed: fakeEmbed,
    });
    assertChunkInvariants(text, chunks, 20, wordCounter);
    expect(chunks).toHaveLength(1);
  });
});

describe("sectionChunker", () => {
  test("splits on markdown headings and tiles the document", () => {
    const chunks = sectionChunker(MARKDOWN_DOC, {
      maxTokens: 40,
      countTokens: wordCounter,
    });
    assertChunkInvariants(MARKDOWN_DOC, chunks, 40, wordCounter);
    // section boundaries: no chunk should contain a heading that is not at its start
    for (const c of chunks) {
      const lines = c.text.split("\n");
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i]).not.toMatch(/^#{1,6} /);
      }
    }
  });

  test("recursively splits oversized sections", () => {
    const chunks = sectionChunker(MARKDOWN_DOC, {
      maxTokens: 10,
      countTokens: wordCounter,
    });
    assertChunkInvariants(MARKDOWN_DOC, chunks, 10, wordCounter);
  });

  test("handles documents with no headings", () => {
    const chunks = sectionChunker(PARAGRAPHS, {
      maxTokens: 20,
      countTokens: wordCounter,
    });
    assertChunkInvariants(PARAGRAPHS, chunks, 20, wordCounter);
  });
});
