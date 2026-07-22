import {
  EMBED_BATCH_MAX,
  EMBED_MAX_TOKENS,
  MODEL_IDS,
  type TokenCounter,
} from "@tos-rag/core";
import {
  assertVectors,
  batched,
  warnOnce,
  withDocumentPrefix,
  withQueryPrefix,
  type Embedder,
} from "./embedder";

/**
 * Local embeddinggemma-300m over ONNX (transformers.js).
 *
 * This is the experiment's embedder for both ingestion and query time. Using
 * the same weights, dtype and pooling on both sides is the point: indexing
 * locally while querying a remote endpoint whose serving dtype and pooling are
 * undocumented would make retrieval metrics measure a vector-space mismatch
 * rather than the chunking strategy under test.
 *
 * Consequence, logged as a PRD divergence: the backend is Node-only (PRD §15).
 */

/** fp16 is NOT an option — embeddinggemma's activations do not support it. */
export type LocalDtype = "fp32" | "q8" | "q4";

export interface LocalEmbedderOptions {
  dtype?: LocalDtype;
  /**
   * Batch size for the local forward pass. Defaults well under EMBED_BATCH_MAX
   * (100): that constant is an upper guard, not a target, and 100 padded
   * 512-token sequences is already a large activation tensor on a laptop.
   */
  batchSize?: number;
}

export async function createLocalEmbedder(
  opts: LocalEmbedderOptions = {},
): Promise<Embedder> {
  const dtype = opts.dtype ?? "fp32";
  const batchSize = opts.batchSize ?? 32;
  if (batchSize > EMBED_BATCH_MAX) {
    throw new Error(
      `Batch size ${batchSize} exceeds EMBED_BATCH_MAX (${EMBED_BATCH_MAX}).`,
    );
  }

  // Dynamic so a future Worker bundle never statically pulls in transformers.js.
  const { AutoModel, AutoTokenizer } = await import("@huggingface/transformers");

  const modelId = MODEL_IDS.embedderLocal;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModel.from_pretrained(modelId, { dtype });

  const warn = warnOnce();

  // from_pretrained is async, but encode is synchronous afterward — which is
  // exactly the shape the chunkers need (PRD §8.2).
  const countTokens: TokenCounter = (text) => tokenizer.encode(text).length;

  async function embedPrefixed(prefixed: string[]): Promise<number[][]> {
    prefixed.forEach((text, i) => {
      const tokens = countTokens(text);
      if (tokens > EMBED_MAX_TOKENS) {
        throw new Error(
          `Input ${i} is ${tokens} tokens, over the ${EMBED_MAX_TOKENS}-token limit. ` +
            `It would be silently truncated, so the stored vector would not represent the stored text.`,
        );
      }
    });

    const out: number[][] = [];
    for (const batch of batched(prefixed, batchSize)) {
      const inputs = await tokenizer(batch, { padding: true });
      const { sentence_embedding } = await model(inputs);
      out.push(...(sentence_embedding.tolist() as number[][]));
    }
    return assertVectors(out, warn);
  }

  return {
    name: `local:${modelId}:${dtype}`,
    countTokens,
    embedQuery: async (text) => {
      const [vector] = await embedPrefixed([withQueryPrefix(text)]);
      return vector!;
    },
    embedDocuments: (texts) =>
      texts.length === 0
        ? Promise.resolve([])
        : embedPrefixed(texts.map(withDocumentPrefix)),
  };
}
