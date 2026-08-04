import { z } from "zod";
import type { Strategy } from "./types";

/** Gold clause span in canonical-document character offsets (PRD §6). */
export const GoldSpanSchema = z
  .object({
    char_start: z.number().int().nonnegative(),
    char_end: z.number().int().nonnegative(),
  })
  .refine((s) => s.char_end > s.char_start, {
    message: "char_end must be greater than char_start",
  });

export const QTYPES = [
  "factual",
  "multi_clause",
  "comparison",
  "unanswerable",
] as const;

/** One line of corpus/questions/<doc_id>.jsonl (PRD §6). */
export const QuestionRecordSchema = z.object({
  id: z.string().min(1),
  doc_id: z.string().min(1),
  qtype: z.enum(QTYPES),
  question: z.string().min(1),
  expected_answer: z.string().min(1),
  gold_spans: z.array(GoldSpanSchema),
  phase1: z.boolean(),
});

export type QuestionRecord = z.infer<typeof QuestionRecordSchema>;

/** Experiment constants (PRD §7). */
export const CHUNK_SIZES = [128, 256, 512] as const;
export const RETRIEVAL_K = 5;
export const GENERATION_SEED = 42;
export const GENERATION_MAX_TOKENS = 1024;

export const MODEL_IDS = {
  embedderLocal: "onnx-community/embeddinggemma-300m-ONNX",
  llama: "llama3.1:8b", // Ollama tag (was @cf/meta/... via a managed inference API; PRD §15)
  opus: "claude-opus-4-8",
  judge: "claude-sonnet-5",
} as const;

/**
 * The Phase 1 winner (PRD §7 selection rule: best mean Truthfulness, ties →
 * char recall → latency). Frozen as a constant rather than read from
 * `analysis_results` at runtime: the demo pipeline must not depend on the
 * analysis step having run, nor change underneath it when analysis re-runs.
 */
export const PHASE1_WINNER = { strategy: "sentence", chunkSize: 512 } as const satisfies {
  strategy: Strategy;
  chunkSize: (typeof CHUNK_SIZES)[number];
};

/**
 * EmbeddingGemma's asymmetric prompt prefixes. The model was trained with
 * different instructions for queries and documents; using the wrong one — or
 * none — degrades retrieval silently, with no error anywhere.
 *
 * The trailing spaces are significant. Do not "tidy" them.
 *
 * These are applied ONLY to the string handed to the embedder. They must never
 * reach the persisted `chunks.text`, which has to keep satisfying the offset
 * invariant `chunk.text === canonical.slice(charStart, charEnd)` (PRD §8.3).
 */
export const EMBED_PREFIXES = {
  query: "task: search result | query: ",
  document: "title: none | text: ",
} as const;

/** embeddinggemma-300m output width (PRD §9: `embedding vector(768)`). */
export const EMBED_DIMS = 768;

/** Local ONNX context window. */
export const EMBED_MAX_TOKENS = 2048;

/** Forward-pass batch guard for the local ONNX embedder: at most 100 texts per
 * batch, to bound peak memory during ingestion (PRD §8.4). */
export const EMBED_BATCH_MAX = 100;
