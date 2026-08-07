import { describe, expect, it } from "vitest";
import { parseAnalysis } from "../src/results";
import type { AnalysisRow } from "../src/types";
import fixture from "./fixtures/analysis-results.json";

const ROWS = fixture as AnalysisRow[];

describe("parseAnalysis", () => {
  it("reads all 15 Phase-1 configurations in rank order", () => {
    const d = parseAnalysis(ROWS);
    expect(d.phase1).toHaveLength(15);
    expect(d.phase1![0]!.rank).toBe(1);
    expect(d.phase1![0]!.strategy).toBe("sentence");
    expect(d.phase1![0]!.chunkSize).toBe(512);
    expect(d.winner).toBe("sentence:512");
  });

  it("preserves a null CI instead of inventing one", () => {
    const d = parseAnalysis(ROWS);
    const top = d.phase1![0]!;
    expect(top.hitRate!.ci).toBeNull();
    expect(top.hitRate!.ciOmittedReason).toBe("zero variance in sample");
  });

  it("keeps each metric's own n, because retrieval metrics skip unanswerables", () => {
    const d = parseAnalysis(ROWS);
    const top = d.phase1![0]!;
    expect(top.truthfulness.n).toBe(20);
    expect(top.charRecall!.n).toBe(16);
  });

  it("reads the factor breakdowns rather than averaging config rows", () => {
    const d = parseAnalysis(ROWS);
    expect(d.bySize!.map((l) => l.label)).toEqual(
      expect.arrayContaining(["128", "256", "512"]),
    );
    const size256 = d.bySize!.find((l) => l.label === "256")!;
    expect(size256.estimate.mean).toBeCloseTo(0.77, 5);
    expect(size256.estimate.ci).not.toBeNull();
  });

  it("reads the Phase-2 paired table with its win counts and Holm p-values", () => {
    const d = parseAnalysis(ROWS);
    const crag = d.phase2!.rows.find((r) => r.metric === "crag_score")!;
    expect(crag.llama!.mean).toBeCloseTo(0.6, 5);
    expect(crag.opus!.mean).toBeCloseTo(0.9333, 3);
    expect(crag.wins).toBe(5);
    expect(crag.losses).toBe(0);
    expect(crag.ties).toBe(25);
    expect(crag.significant).toBe(false);
    expect(crag.floorNote).toContain("discordant");
  });

  it("reads latency as stored five-number summaries", () => {
    const d = parseAnalysis(ROWS);
    const gen = d.latency!.find(
      (s) => s.model === "opus" && s.stage === "generation",
    )!;
    expect(gen.stats.q1).toBeLessThanOrEqual(gen.stats.median);
    expect(gen.stats.median).toBeLessThanOrEqual(gen.stats.q3);
  });

  it("reads the judge validation gate", () => {
    const d = parseAnalysis(ROWS);
    expect(d.judge!.kappa).toBeCloseTo(0.92, 3);
    expect(d.judge!.threshold).toBe(0.61);
    expect(d.judge!.passes).toBe(true);
  });

  it("preserves a null percentAgreement instead of coercing it to 0", () => {
    const judgeRow = ROWS.find((r) => r.analysis === "judge_validation")!;
    const payload = JSON.parse(JSON.stringify(judgeRow.payload)) as {
      judge_vs_human: Record<string, unknown>;
    };
    delete payload.judge_vs_human["percent_agreement"];
    const d = parseAnalysis([{ analysis: "judge_validation", payload }]);
    expect(d.judge).not.toBeNull();
    expect(d.judge!.percentAgreement).toBeNull();
    expect(d.judge!.kappa).toBeCloseTo(0.92, 3);
  });

  it("returns nulls for every slice when given no rows", () => {
    const d = parseAnalysis([]);
    expect(d.phase1).toBeNull();
    expect(d.phase2).toBeNull();
    expect(d.judge).toBeNull();
    expect(d.latency).toBeNull();
  });

  it("nulls only the missing slice when one key is absent", () => {
    const d = parseAnalysis(ROWS.filter((r) => r.analysis !== "phase2_paired"));
    expect(d.phase1).not.toBeNull();
    expect(d.phase2).toBeNull();
    expect(d.latency).toBeNull();
    expect(d.cost).toBeNull();
  });

  it("survives a malformed payload without throwing", () => {
    const d = parseAnalysis([{ analysis: "phase1_config_ranking", payload: 42 }]);
    expect(d.phase1).toBeNull();
  });
});
