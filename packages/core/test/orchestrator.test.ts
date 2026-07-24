import { describe, expect, it, vi } from "vitest";
import {
  planRuns,
  runKeyOf,
  runOne,
  type GenerationResult,
  type Judge,
  type OrchestratorDeps,
  type RetrievedChunk,
  type RunOneInput,
} from "../src/index";

function fakeGen(answer: string): GenerationResult {
  return { answer, inputTokens: 100, outputTokens: 20, latencyMs: 42 };
}

const CHUNKS: RetrievedChunk[] = [
  { docId: "github-tos", charStart: 150, charEnd: 250, text: "…", score: 0.9 },
  { docId: "netflix-tou", charStart: 10, charEnd: 60, text: "…", score: 0.7 },
];

const input: RunOneInput = {
  question: {
    id: "github-q01",
    docId: "github-tos",
    question: "How much notice before fee changes?",
    expectedAnswer: "At least 30 days.",
    goldSpans: [{ charStart: 100, charEnd: 200 }],
  },
  config: { strategy: "sentence", chunkSize: 256 },
  model: "llama",
};

function deps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    retrieve: async () => CHUNKS,
    generate: async () => fakeGen("GitHub gives at least 30 days notice."),
    judge: { async complete() { return '{"score":"accurate","explanation":"same"}'; } },
    ...overrides,
  };
}

describe("runOne", () => {
  it("retrieves over the whole corpus with the given config", async () => {
    const retrieve = vi.fn(async () => CHUNKS);
    await runOne(input, deps({ retrieve }));
    expect(retrieve).toHaveBeenCalledWith(input.question.question, {
      strategy: "sentence",
      chunkSize: 256,
    });
  });

  it("assembles the run row and eval scores", async () => {
    const result = await runOne(input, deps());
    expect(result.answer).toBe("GitHub gives at least 30 days notice.");
    expect(result.input_tokens).toBe(100);
    expect(result.generation_ms).toBe(42);
    // retrieved is reduced to the persisted shape
    expect(result.retrieved).toEqual([
      { doc_id: "github-tos", char_start: 150, char_end: 250, score: 0.9 },
      { doc_id: "netflix-tou", char_start: 10, char_end: 60, score: 0.7 },
    ]);
    // gold span (100–200) vs retrieved github span (150–250) overlap = 50 chars
    expect(result.scores.char_recall).toBeCloseTo(0.5);
    expect(result.scores.crag_score).toBe(1);
  });

  it("attaches the question's docId to gold spans (so cross-doc retrieval scores correctly)", async () => {
    // Only the netflix chunk is retrieved; the gold span is in github-tos, so
    // there must be zero overlap — proving gold spans are scoped to their doc.
    const result = await runOne(input, deps({ retrieve: async () => [CHUNKS[1]!] }));
    expect(result.scores.char_recall).toBe(0);
    expect(result.scores.hit_at_8).toBe(0);
  });

  it("propagates a judge failure (so the run is retried, not silently scored)", async () => {
    const judge: Judge = { async complete() { return "no verdict here"; } };
    await expect(runOne(input, deps({ judge }))).rejects.toThrow();
  });
});

describe("planRuns", () => {
  it("returns every config × question pair when nothing is done", () => {
    const pending = planRuns([1, 2], ["qa", "qb"], new Set());
    expect(pending).toHaveLength(4);
    expect(pending[0]).toEqual({ configId: 1, questionId: "qa" });
  });

  it("skips pairs already completed (resume)", () => {
    const done = new Set([runKeyOf(1, "qa"), runKeyOf(2, "qb")]);
    const pending = planRuns([1, 2], ["qa", "qb"], done);
    expect(pending).toEqual([
      { configId: 1, questionId: "qb" },
      { configId: 2, questionId: "qa" },
    ]);
  });

  it("returns nothing when all are done", () => {
    const done = new Set([runKeyOf(1, "qa")]);
    expect(planRuns([1], ["qa"], done)).toEqual([]);
  });
});
