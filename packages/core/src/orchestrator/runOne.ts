import { evaluateRun, type EvalScores, type Judge } from "../eval/evaluate";
import { buildRagPrompt } from "../prompts";
import type {
  GenerationResult,
  GeneratorModel,
  RetrievedChunk,
  Span,
  Strategy,
} from "../types";

/**
 * The pure heart of the orchestrator (PRD §4 run-one): one experiment run —
 * retrieve → generate → evaluate — for a single (question × config × model).
 * No I/O; retrieval, generation, and judging are injected, so the whole thing
 * is unit-tested with fakes. Persistence and the resume loop live in the CLI.
 */

export interface OrchestratorDeps {
  /** Whole-corpus retrieval for a config (no doc filter, PRD §7). */
  retrieve: (
    question: string,
    opts: { strategy: Strategy; chunkSize: number },
  ) => Promise<RetrievedChunk[]>;
  generate: (prompt: string, model: GeneratorModel) => Promise<GenerationResult>;
  judge: Judge;
}

export interface RunOneInput {
  question: {
    id: string;
    docId: string;
    question: string;
    expectedAnswer: string;
    /** Gold spans as stored: offsets into the question's own document. */
    goldSpans: Span[];
  };
  config: { strategy: Strategy; chunkSize: number };
  model: GeneratorModel;
}

/** The retrieved-chunk shape persisted to `runs.retrieved` (PRD §9). */
export interface RetrievedRef {
  doc_id: string;
  char_start: number;
  char_end: number;
  score: number;
}

export interface RunOneResult {
  retrieved: RetrievedRef[];
  answer: string;
  retrieval_ms: number;
  generation_ms: number;
  input_tokens: number;
  output_tokens: number;
  scores: EvalScores;
}

export async function runOne(
  input: RunOneInput,
  deps: OrchestratorDeps,
): Promise<RunOneResult> {
  const { question, config, model } = input;

  const t0 = Date.now();
  const retrieved = await deps.retrieve(question.question, config);
  const retrieval_ms = Date.now() - t0;

  const gen = await deps.generate(
    buildRagPrompt(question.question, retrieved),
    model,
  );

  const scores = await evaluateRun(
    {
      question: question.question,
      expectedAnswer: question.expectedAnswer,
      answer: gen.answer,
      // Gold spans are offsets into the question's document; the char-span
      // metrics group by document, so attach the docId before scoring.
      goldSpans: question.goldSpans.map((s) => ({
        docId: question.docId,
        charStart: s.charStart,
        charEnd: s.charEnd,
      })),
      retrieved: retrieved.map((r) => ({
        docId: r.docId,
        charStart: r.charStart,
        charEnd: r.charEnd,
      })),
    },
    { judge: deps.judge },
  );

  return {
    retrieved: retrieved.map((r) => ({
      doc_id: r.docId,
      char_start: r.charStart,
      char_end: r.charEnd,
      score: r.score,
    })),
    answer: gen.answer,
    retrieval_ms,
    generation_ms: gen.latencyMs,
    input_tokens: gen.inputTokens,
    output_tokens: gen.outputTokens,
    scores,
  };
}

/** A pending unit of work: one config × one question. */
export interface RunKey {
  configId: number;
  questionId: string;
}

/** The string key identifying a completed run within a fixed (phase, model). */
export function runKeyOf(configId: number, questionId: string): string {
  return `${configId}:${questionId}`;
}

/**
 * The resume plan: every (config, question) pair not already in `done`, in a
 * deterministic order (config-major). Pure, so the skip logic is unit-tested
 * without a database.
 */
export function planRuns(
  configIds: number[],
  questionIds: string[],
  done: ReadonlySet<string>,
): RunKey[] {
  const pending: RunKey[] = [];
  for (const configId of configIds) {
    for (const questionId of questionIds) {
      if (!done.has(runKeyOf(configId, questionId))) {
        pending.push({ configId, questionId });
      }
    }
  }
  return pending;
}
