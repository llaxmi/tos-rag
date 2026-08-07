export interface Evidence {
  docId: string;
  charStart: number;
  charEnd: number;
  text: string;
  score: number;
}

/**
 * A frozen canonical document as served to the browser (PRD §5). `charLength`
 * is `text.length` — UTF-16 code units, the unit every chunk offset and gold
 * span is recorded in. Postgres `length()` counts codepoints and will disagree;
 * do not substitute it.
 */
export interface CanonicalDocument {
  docId: string;
  title: string;
  version: number;
  sha256: string;
  charLength: number;
  text: string;
}

/** Display names for the two frozen documents — the single source for UI labels. */
export const DOC_LABELS: Record<string, string> = {
  "github-tos": "GitHub ToS",
  "netflix-tou": "Netflix ToU",
};

/** Re-exported, not re-declared: the arms are a frozen experimental control
 * owned by @tos-rag/core, and a second copy here could silently drift. */
import { RETRIEVAL_K, type GeneratorModel } from "@tos-rag/core";
export type { GeneratorModel };
export { RETRIEVAL_K };

/** Display names for the two generators — the single source for UI labels. */
export const MODEL_LABELS: Record<GeneratorModel, string> = {
  llama: "Llama 3.1 8B",
  opus: "Claude Opus 4.8",
};

/** The proposal's three experimental variables, selectable in the demo. */
export interface PipelineConfig {
  strategy: string;
  chunkSize: number;
  model: GeneratorModel;
}

export interface AskResponse {
  answer: string;
  abstained: boolean;
  evidence: Evidence[];
  config: { strategy: string; chunkSize: number };
  model: GeneratorModel;
  /** The exact text handed to the generator — the frozen template with the
   *  retrieved chunks interpolated. Reported, never re-derived, so the trace
   *  view cannot drift from what was actually sent. */
  prompt: string;
  timings: { retrievalMs: number; generationMs: number };
  tokens: { input: number; output: number };
}

export type DocFilter = "github-tos" | "netflix-tou" | undefined;

export interface AnalysisRow {
  analysis: string;
  payload: unknown;
}
