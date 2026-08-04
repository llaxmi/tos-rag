import { evaluateRun, type EvalScores, type Judge } from "../eval/evaluate";
import { buildRagPrompt } from "../prompts";
import {
  GENERATOR_MODELS,
  type GenerationResult,
  type GeneratorModel,
  type RetrievedChunk,
  type Span,
  type Strategy,
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

/** A pending Phase-2 unit of work: one generator arm × one question. */
export interface Phase2RunKey {
  model: GeneratorModel;
  questionId: string;
}

/**
 * Phase 2 (PRD §7 Objective 2) holds the config fixed at the Phase-1 winner and
 * fans out over the generator arms instead — per arm, the same skip logic as
 * `planRuns`. Resume is per-arm, so the done-sets arrive keyed by model — each
 * one as returned by `getCompletedRunKeys(2, MODEL_IDS[model])`, in `runKeyOf`
 * form. `models` defaults to all arms in `GENERATOR_MODELS` order (Llama before
 * Opus, so a `--limit` smoke run exercises the free arm first); a single-arm
 * invocation passes just that arm.
 *
 * `doneByModel` is partial because a single-arm invocation only queries the arm
 * it is running — an entry missing means "nothing done for that arm", which is
 * what an unqueried arm truthfully is. Requiring every key would force callers
 * to either fabricate an empty set or assert a record they never built.
 */
export function planPhase2Runs(
  configId: number,
  questionIds: string[],
  doneByModel: Readonly<Partial<Record<GeneratorModel, ReadonlySet<string>>>>,
  models: readonly GeneratorModel[] = GENERATOR_MODELS,
): Phase2RunKey[] {
  return models.flatMap((model) =>
    planRuns([configId], questionIds, doneByModel[model] ?? EMPTY_DONE).map(
      ({ questionId }) => ({ model, questionId }),
    ),
  );
}

const EMPTY_DONE: ReadonlySet<string> = new Set();
