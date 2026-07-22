import { beforeAll, describe, expect, test } from "vitest";
import { EMBED_DIMS, cosineSimilarity } from "@tos-rag/core";
import { createLocalEmbedder } from "../src/adapters/embedder.local";
import type { Embedder } from "../src/adapters/embedder";

/**
 * NOT hermetic — loads ~1.2GB of ONNX weights. Excluded from `pnpm test`; run
 * with `pnpm --filter backend test:live`.
 *
 * This is the check that the prefixes and pooling are actually right. Unit
 * tests can only confirm the prefix strings are prepended; only a real forward
 * pass shows whether the resulting vector space ranks sensibly.
 */
describe("local embeddinggemma", () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = await createLocalEmbedder();
  });

  test("produces unit vectors of the schema's width", async () => {
    const [v] = await embedder.embedDocuments(["GitHub may terminate your account."]);
    expect(v).toHaveLength(EMBED_DIMS);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  });

  test("ranks the relevant document first", async () => {
    // The model card's own example. If this fails, the prefixes or the pooling
    // are wrong — not the model.
    const docs = [
      "Venus is often called Earth's twin because of its similar size and proximity.",
      "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
      "Jupiter, the largest planet in our solar system, has a prominent red spot.",
    ];
    const query = await embedder.embedQuery("Which planet is known as the Red Planet?");
    const vectors = await embedder.embedDocuments(docs);
    const scores = vectors.map((v) => cosineSimilarity(query, v));
    const best = scores.indexOf(Math.max(...scores));
    expect(best).toBe(1);
  });

  test("ranks a relevant ToS clause above an unrelated one", async () => {
    const [fees, age] = await embedder.embedDocuments([
      "We will give you at least 30 days notice before any fee change takes effect.",
      "You must be at least 13 years old to use the Service.",
    ]);
    const query = await embedder.embedQuery(
      "How much notice does GitHub give before changing fees?",
    );
    expect(cosineSimilarity(query, fees!)).toBeGreaterThan(cosineSimilarity(query, age!));
  });

  test("counts tokens with the model's own tokenizer", async () => {
    expect(embedder.countTokens("hello world")).toBeGreaterThan(0);
    // Monotonic in length — packByBudget's binary search depends on this.
    expect(embedder.countTokens("a b c d e f g h")).toBeGreaterThan(
      embedder.countTokens("a b"),
    );
  });
});
