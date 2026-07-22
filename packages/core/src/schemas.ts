import { z } from "zod";

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
export const RETRIEVAL_K = 8;
export const GENERATION_SEED = 42;
export const GENERATION_MAX_TOKENS = 1024;

export const MODEL_IDS = {
  embedder: "@cf/google/embeddinggemma-300m",
  llama: "@cf/meta/llama-3.1-8b-instruct-fast",
  opus: "claude-opus-4-8",
  judge: "claude-sonnet-5",
} as const;
