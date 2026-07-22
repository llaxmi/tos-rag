import { createLocalEmbedder, type LocalDtype } from "./embedder.local";
import type { Embedder } from "./embedder";

export type { Embedder } from "./embedder";
export { batched, withDocumentPrefix, withQueryPrefix } from "./embedder";
export { createLocalEmbedder, type LocalDtype } from "./embedder.local";
export {
  loadCanonical,
  normalizeCanonical,
  sha256,
  type CanonicalDoc,
} from "./canonical";

export interface EmbedderEnv {
  EMBEDDER?: string;
  EMBEDDER_DTYPE?: string;
}

/**
 * The experiment's embedder is the local ONNX embeddinggemma-300m, for both
 * ingestion and query time (PRD §8, §15). `EMBEDDER` is still read for
 * forward-compat but only `local` is supported now that the remote
 * query-time embedder has been removed; `EMBEDDER_DTYPE` selects fp32 | q8 | q4.
 */
export async function createEmbedder(env: EmbedderEnv): Promise<Embedder> {
  if (env.EMBEDDER && env.EMBEDDER !== "local") {
    throw new Error(
      `EMBEDDER=${env.EMBEDDER} is not supported — only the local ONNX embedder remains.`,
    );
  }
  return createLocalEmbedder({
    dtype: env.EMBEDDER_DTYPE as LocalDtype | undefined,
  });
}
