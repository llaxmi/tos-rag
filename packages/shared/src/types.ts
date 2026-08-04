export interface Evidence {
  docId: string;
  charStart: number;
  charEnd: number;
  text: string;
  score: number;
}

/** Re-exported, not re-declared: the arms are a frozen experimental control
 * owned by @tos-rag/core, and a second copy here could silently drift. */
import type { GeneratorModel } from "@tos-rag/core";
export type { GeneratorModel };

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
  timings: { retrievalMs: number; generationMs: number };
  tokens: { input: number; output: number };
}

export type DocFilter = "github-tos" | "netflix-tou" | undefined;

export interface AnalysisRow {
  analysis: string;
  payload: unknown;
}
