import { describe, expect, it } from "vitest";
import { ABSTENTION_TEXT } from "@tos-rag/core";
import type { BackfillRow } from "@tos-rag/db";
import { parseBackfillArgs, ALL_METRICS } from "../src/scripts/args";
import { planWork, requireJudgeKey } from "../src/scripts/backfill-metrics";

describe("parseBackfillArgs", () => {
  it("defaults to a dry run over every metric and both phases", () => {
    expect(parseBackfillArgs([])).toEqual({
      apply: false,
      force: false,
      phase: undefined,
      metrics: ALL_METRICS,
    });
  });

  it("reads --apply and --force", () => {
    const a = parseBackfillArgs(["--apply", "--force"]);
    expect(a.apply).toBe(true);
    expect(a.force).toBe(true);
  });

  it("restricts to one phase", () => {
    expect(parseBackfillArgs(["--phase", "2"]).phase).toBe(2);
    expect(parseBackfillArgs(["--phase=1"]).phase).toBe(1);
  });

  it("rejects a phase that is not 1 or 2", () => {
    expect(() => parseBackfillArgs(["--phase", "3"])).toThrow(/--phase must be/);
  });

  it("restricts to one metric", () => {
    expect(parseBackfillArgs(["--metric", "cosine"]).metrics).toEqual(["cosine"]);
  });

  it("rejects an unknown metric rather than silently doing all of them", () => {
    expect(() => parseBackfillArgs(["--metric", "bleu"])).toThrow(/--metric must be one of/);
  });

  it.each(["--phase", "--metric"])("rejects a dangling %s selector", (flag) => {
    expect(() => parseBackfillArgs([flag])).toThrow(`${flag} requires a value`);
    expect(() => parseBackfillArgs([`${flag}=`])).toThrow(`${flag} requires a value`);
  });

  it("rejects a selector whose value is another flag", () => {
    expect(() => parseBackfillArgs(["--metric", "--apply"])).toThrow(
      "--metric requires a value",
    );
  });

  it("rejects unknown flags and positional arguments", () => {
    expect(() => parseBackfillArgs(["--metirc", "cosine", "--apply"])).toThrow(
      'Unknown argument "--metirc"',
    );
    expect(() => parseBackfillArgs(["cosine"])).toThrow('Unknown argument "cosine"');
  });
});

/** A minimal, fully-specified BackfillRow — override only what a test cares about. */
function backfillRow(overrides: Partial<BackfillRow> = {}): BackfillRow {
  return {
    runId: 1n,
    phase: 1,
    model: "llama3.1:8b",
    questionId: "q1",
    question: "How much notice does GitHub give before changing fees?",
    answer: "GitHub gives 30 days' notice.",
    expectedAnswer: "At least 30 days' notice.",
    retrieved: [],
    inputTokens: 100,
    outputTokens: 50,
    faithfulness: null,
    cosineSim: null,
    costUsd: null,
    ...overrides,
  };
}

describe("planWork", () => {
  const allMetrics = { force: false, metrics: [...ALL_METRICS] };

  it("never selects a Phase-1 row for cost, even with --force", () => {
    const rows = [backfillRow({ phase: 1, costUsd: null })];
    expect(planWork(rows, allMetrics).cost).toEqual([]);
    expect(planWork(rows, { force: true, metrics: [...ALL_METRICS] }).cost).toEqual([]);
  });

  it("skips a Phase-2 row with a stored cost_usd, and --force re-selects it", () => {
    const rows = [backfillRow({ phase: 2, costUsd: 0.05 })];
    expect(planWork(rows, allMetrics).cost).toEqual([]);
    expect(planWork(rows, { force: true, metrics: [...ALL_METRICS] }).cost).toEqual(rows);
  });

  it("selects a Phase-2 row with no stored cost_usd", () => {
    const rows = [backfillRow({ phase: 2, costUsd: null })];
    expect(planWork(rows, allMetrics).cost).toEqual(rows);
  });

  it("never enters an abstention's row into the faithfulness list", () => {
    const rows = [backfillRow({ answer: ABSTENTION_TEXT, faithfulness: null })];
    expect(planWork(rows, allMetrics).faithfulness).toEqual([]);
    expect(planWork(rows, { force: true, metrics: [...ALL_METRICS] }).faithfulness).toEqual([]);
  });

  it("treats a stored 0 as done — a legitimate score, not a missing one", () => {
    // 0 is a real cosine_sim and a real Llama cost_usd. "Pending" must be
    // `current === null` only, or 0 reads as falsy and gets redone — which for
    // faithfulness means paying for it again.
    const rows = [
      backfillRow({ phase: 2, cosineSim: 0, costUsd: 0, faithfulness: 0 }),
    ];
    const todo = planWork(rows, allMetrics);
    expect(todo.cosine).toEqual([]);
    expect(todo.cost).toEqual([]);
    expect(todo.faithfulness).toEqual([]);
  });

  it("re-selects a stored 0 under --force", () => {
    const rows = [
      backfillRow({ phase: 2, cosineSim: 0, costUsd: 0, faithfulness: 0 }),
    ];
    const todo = planWork(rows, { force: true, metrics: [...ALL_METRICS] });
    expect(todo.cosine).toEqual(rows);
    expect(todo.cost).toEqual(rows);
    expect(todo.faithfulness).toEqual(rows);
  });

  it("--metric restricts which lists are populated", () => {
    const rows = [backfillRow({ phase: 2, faithfulness: null, cosineSim: null, costUsd: null })];
    const todo = planWork(rows, { force: false, metrics: ["cosine"] });
    expect(todo.cosine).toEqual(rows);
    expect(todo.faithfulness).toEqual([]);
    expect(todo.cost).toEqual([]);
  });
});

describe("requireJudgeKey", () => {
  const faithfulnessTodo = { faithfulness: [backfillRow()] };
  const emptyTodo = { faithfulness: [] };

  it("does not require a key for a dry run with faithfulness work", () => {
    expect(() => requireJudgeKey({ apply: false }, faithfulnessTodo, undefined)).not.toThrow();
  });

  it("does not require a key when an applied/resumed backfill has no faithfulness work", () => {
    expect(() => requireJudgeKey({ apply: true }, emptyTodo, undefined)).not.toThrow();
  });

  it("requires a key when an applied backfill has faithfulness work", () => {
    expect(() => requireJudgeKey({ apply: true }, faithfulnessTodo, undefined)).toThrow(
      /ANTHROPIC_API_KEY is required/,
    );
    expect(() => requireJudgeKey({ apply: true }, faithfulnessTodo, "test-key")).not.toThrow();
  });
});
