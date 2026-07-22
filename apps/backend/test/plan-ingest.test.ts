import { describe, expect, test } from "vitest";
import { EMBED_PREFIXES, type TokenCounter } from "@tos-rag/core";
import { withDocumentPrefix } from "../src/adapters/embedder";
import { planIngest, type PlanIngestDeps } from "../src/scripts/plan-ingest";

const DOC = [
  "# Terms of Service",
  "",
  "You must be at least 13 years old to use the Service. Accounts registered by bots are not permitted.",
  "",
  "## B. Payment",
  "",
  "We will give you at least 30 days notice before any fee change takes effect. Fees are billed monthly.",
].join("\n");

/** 1 token per whitespace-delimited word — deterministic and monotonic. */
const wordCounter: TokenCounter = (text) => text.split(/\s+/).filter(Boolean).length;

/**
 * Stands in for the real embedder: records exactly what it was asked to embed
 * so tests can assert the prefix reached the model but not the database.
 */
function fakeEmbedder(): PlanIngestDeps & { seen: string[] } {
  const seen: string[] = [];
  const embedDocuments = async (texts: string[]): Promise<number[][]> => {
    seen.push(...texts.map(withDocumentPrefix));
    return texts.map((t) => [t.length, 0, 0, 1]);
  };
  return {
    seen,
    countTokens: wordCounter,
    embedDocuments,
  };
}

describe("planIngest", () => {
  test("produces rows that satisfy the offset invariant after embedding", async () => {
    // The invariant is the whole basis of char-span retrieval metrics, so it is
    // asserted on the rows actually headed for the database — not just on the
    // chunker's output before the embed step ran.
    const deps = fakeEmbedder();
    const rows = await planIngest(DOC, "github-tos", "sentence", 32, deps);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text).toBe(DOC.slice(row.char_start, row.char_end));
    }
  });

  test("tiles the document contiguously with no gaps", async () => {
    const rows = await planIngest(DOC, "github-tos", "sentence", 32, fakeEmbedder());
    expect(rows[0]!.char_start).toBe(0);
    expect(rows[rows.length - 1]!.char_end).toBe(DOC.length);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.char_start).toBe(rows[i - 1]!.char_end);
    }
  });

  test("stores unprefixed text while embedding prefixed text", async () => {
    // The single most dangerous confusion in the pipeline: the prefix must
    // reach the model and never the `text` column, or every offset shifts.
    const deps = fakeEmbedder();
    const rows = await planIngest(DOC, "github-tos", "sentence", 32, deps);

    for (const row of rows) {
      expect(row.text.startsWith(EMBED_PREFIXES.document)).toBe(false);
    }
    expect(deps.seen).toHaveLength(rows.length);
    for (const sent of deps.seen) {
      expect(sent.startsWith(EMBED_PREFIXES.document)).toBe(true);
    }
  });

  test("pairs each row with its own embedding, in order", async () => {
    const deps = fakeEmbedder();
    const rows = await planIngest(DOC, "github-tos", "sentence", 32, deps);
    // The fake encodes text length in the vector, so a transposition shows up.
    for (const row of rows) {
      expect(row.embedding[0]).toBe(row.text.length);
    }
  });

  test("records token counts within the configured budget", async () => {
    const rows = await planIngest(DOC, "github-tos", "sentence", 32, fakeEmbedder());
    for (const row of rows) {
      expect(row.token_count).toBe(wordCounter(row.text));
      expect(row.token_count).toBeLessThanOrEqual(32);
    }
  });

  test("tags every row with the document id", async () => {
    const rows = await planIngest(DOC, "netflix-tou", "fixed", 32, fakeEmbedder());
    expect(rows.every((r) => r.doc_id === "netflix-tou")).toBe(true);
  });

  test("works for every strategy", async () => {
    for (const strategy of ["fixed", "recursive", "sentence", "semantic", "section"] as const) {
      const rows = await planIngest(DOC, "github-tos", strategy, 32, fakeEmbedder());
      for (const row of rows) {
        expect(row.text).toBe(DOC.slice(row.char_start, row.char_end));
      }
    }
  });

  test("throws if the embedder returns the wrong number of vectors", async () => {
    const deps = fakeEmbedder();
    await expect(
      planIngest(DOC, "github-tos", "sentence", 32, {
        ...deps,
        embedDocuments: async () => [[1, 0, 0, 0]],
      }),
    ).rejects.toThrow(/vectors for/);
  });

  test("returns nothing for an empty document", async () => {
    expect(await planIngest("", "github-tos", "sentence", 32, fakeEmbedder())).toEqual([]);
  });
});
