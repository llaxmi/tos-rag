import { describe, expect, it } from "vitest";
import { NO_TEST_METHOD, parseAnalysis, wilcoxonMethodPhrase } from "../src/results";
import type { AnalysisRow } from "../src/types";
import fixture from "./fixtures/analysis-results.json";

const ROWS = fixture as AnalysisRow[];

/** A deep copy of the real `phase2_paired` payload, for tests that mutate one
 *  field (e.g. a metric's `wilcoxon.method`) without hand-rolling a payload
 *  shape that could drift from what the analysis step actually stores. */
function phase2Payload(): Record<string, unknown> {
  const row = ROWS.find((r) => r.analysis === "phase2_paired")!;
  return JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>;
}

function pairedMetrics(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const paired = payload["paired"] as Record<string, unknown>;
  return paired["metrics"] as Array<Record<string, unknown>>;
}

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

  it("reads the winner-vs-rest paired tests, which is what establishes separability", () => {
    const d = parseAnalysis(ROWS);
    expect(d.bestVsRest).not.toBeNull();
    expect(d.bestVsRest!.nComparisons).toBe(14);
    expect(d.bestVsRest!.nSignificant).toBe(0);
    expect(d.bestVsRest!.winner).toBe("sentence:512");
    expect(d.bestVsRest!.correction).toBe("holm");
    expect(d.bestVsRest!.alpha).toBe(0.05);
    expect(d.bestVsRest!.interpretation).toContain("0 of 14");
  });

  it("nulls bestVsRest rather than defaulting its counts when the payload is absent", () => {
    const d = parseAnalysis(
      ROWS.filter((r) => r.analysis !== "phase1_best_vs_rest"),
    );
    expect(d.bestVsRest).toBeNull();
    expect(d.phase1).not.toBeNull();
  });

  it("nulls a missing alpha rather than filling in the experiment's 0.05", () => {
    const row = ROWS.find((r) => r.analysis === "phase1_best_vs_rest")!;
    const payload = { ...(row.payload as Record<string, unknown>) };
    delete payload["alpha"];
    delete payload["correction"];
    delete payload["winner"];
    delete payload["metric"];
    const d = parseAnalysis([{ analysis: "phase1_best_vs_rest", payload }]);
    // The counts still parse, so the slice survives — but no descriptive field
    // is invented. A claimed significance threshold the payload never carried
    // would be a fabricated number.
    expect(d.bestVsRest).not.toBeNull();
    expect(d.bestVsRest!.nComparisons).toBe(14);
    expect(d.bestVsRest!.alpha).toBeNull();
    expect(d.bestVsRest!.correction).toBeNull();
    expect(d.bestVsRest!.winner).toBeNull();
    expect(d.bestVsRest!.metric).toBeNull();
  });

  it("nulls bestVsRest when a required count is missing, never coercing it to 0", () => {
    const row = ROWS.find((r) => r.analysis === "phase1_best_vs_rest")!;
    const payload = { ...(row.payload as Record<string, unknown>) };
    delete payload["n_significant"];
    const d = parseAnalysis([{ analysis: "phase1_best_vs_rest", payload }]);
    expect(d.bestVsRest).toBeNull();
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

  it("reads the judge-validation sampling caveats verbatim", () => {
    const d = parseAnalysis(ROWS);
    expect(d.judge!.caveats).toHaveLength(2);
    expect(d.judge!.caveats[0]).toContain("balanced by judge verdict");
    expect(d.judge!.caveats[1]).toContain("Only rows the judge decided");
  });

  it("drops non-string caveat entries instead of throwing", () => {
    const judgeRow = ROWS.find((r) => r.analysis === "judge_validation")!;
    const payload = JSON.parse(JSON.stringify(judgeRow.payload)) as Record<string, unknown>;
    payload["caveats"] = ["kept", 42, null, "also kept"];
    const d = parseAnalysis([{ analysis: "judge_validation", payload }]);
    expect(d.judge!.caveats).toEqual(["kept", "also kept"]);
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

describe("cost effectiveness", () => {
  it("reads cost per correct answer for both arms from the real fixture", () => {
    const ce = parseAnalysis(ROWS).costEffectiveness!;
    expect(ce).not.toBeNull();

    const opus = ce.perCorrect.find((r) => r.model.startsWith("claude"))!;
    expect(opus.nCorrect).toBe(29);
    expect(opus.nRuns).toBe(30);
    expect(opus.usdPerCorrect).toBeCloseTo(0.0232, 4);

    // A locally served arm is $0.00 per correct answer — a real measurement,
    // not a missing one, so it must not come back null.
    const llama = ce.perCorrect.find((r) => !r.model.startsWith("claude"))!;
    expect(llama.nCorrect).toBe(24);
    expect(llama.usdPerCorrect).toBe(0);
  });

  it("reads the marginal price of the accuracy the paid arm buys", () => {
    const ce = parseAnalysis(ROWS).costEffectiveness!;
    expect(ce.additionalCorrect).toBe(5);
    expect(ce.additionalUSD).toBeCloseTo(0.6719, 4);
    expect(ce.usdPerAdditionalCorrect).toBeCloseTo(0.1344, 4);
  });

  it("reads the input/output split for the priced arm only", () => {
    const ce = parseAnalysis(ROWS).costEffectiveness!;
    expect(ce.split).not.toBeNull();
    // The free arm has no meaningful split, so the priced one is what is kept.
    expect(ce.split!.model.startsWith("claude")).toBe(true);
    expect(ce.split!.inputShare).toBeCloseTo(0.843, 3);
    expect(ce.split!.inputUSD).toBeCloseTo(0.5663, 4);
    expect(ce.split!.outputUSD).toBeCloseTo(0.1056, 4);
  });

  it("reads the outcome buckets and labels them by model, not by role", () => {
    const ce = parseAnalysis(ROWS).costEffectiveness!;
    expect(ce.buckets.map((b) => b.bucket)).toEqual([
      "both_correct", "treatment_only", "baseline_only", "neither",
    ]);
    expect(ce.buckets.reduce((n, b) => n + b.nQuestions, 0)).toBe(30);

    const byBucket = Object.fromEntries(ce.buckets.map((b) => [b.bucket, b]));
    expect(byBucket["treatment_only"]!.label).toBe("Claude Opus 4.8 only");
    expect(byBucket["treatment_only"]!.nQuestions).toBe(5);
    expect(byBucket["treatment_only"]!.opusOutputTokens).toBeCloseTo(300.8, 1);
  });

  it("leaves an empty bucket's answer length null rather than zero", () => {
    // 0.0 mean output tokens would read as "the model answered with nothing"
    // instead of "no question landed in this bucket".
    const ce = parseAnalysis(ROWS).costEffectiveness!;
    const empty = ce.buckets.find((b) => b.bucket === "baseline_only")!;
    expect(empty.nQuestions).toBe(0);
    expect(empty.opusOutputTokens).toBeNull();
    expect(empty.opusCostUSD).toBeNull();
  });

  it("declines to state a marginal price when the paid arm bought no accuracy", () => {
    const payload = phase2Payload();
    const ce = payload["cost_effectiveness"] as Record<string, unknown>;
    ce["marginal"] = {
      additional_correct_answers: 0,
      additional_usd: 0.6719,
      usd_per_additional_correct_answer: null,
    };
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(d.costEffectiveness!.additionalCorrect).toBe(0);
    expect(d.costEffectiveness!.usdPerAdditionalCorrect).toBeNull();
  });

  it("nulls the whole slice when the payload has no cost_effectiveness key", () => {
    // An older stored payload, computed before this analysis existed, must empty
    // its own part of the section rather than break the rest of the page.
    const payload = phase2Payload();
    delete payload["cost_effectiveness"];
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(d.costEffectiveness).toBeNull();
    expect(d.cost).not.toBeNull();
    expect(d.phase2).not.toBeNull();
  });
});

describe("PairedMetricRow.method", () => {
  it("reads the stored wilcoxon.method for a row from the real fixture", () => {
    const d = parseAnalysis(ROWS);
    const crag = d.phase2!.rows.find((r) => r.metric === "crag_score")!;
    expect(crag.method).toBe("permutation (monte carlo, seeded)");
  });

  it("nulls method rather than assuming one when the payload omits it", () => {
    const payload = phase2Payload();
    const crag = pairedMetrics(payload).find((m) => m["metric"] === "crag_score")!;
    delete (crag["wilcoxon"] as Record<string, unknown>)["method"];
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(d.phase2!.rows.find((r) => r.metric === "crag_score")!.method).toBeNull();
  });

  it.each([
    "permutation (exhaustive)",
    "permutation (monte carlo, seeded)",
    NO_TEST_METHOD,
  ])("passes through the stats.py method string %s verbatim", (method) => {
    const payload = phase2Payload();
    const crag = pairedMetrics(payload).find((m) => m["metric"] === "crag_score")!;
    (crag["wilcoxon"] as Record<string, unknown>)["method"] = method;
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(d.phase2!.rows.find((r) => r.metric === "crag_score")!.method).toBe(method);
  });
});

describe("wilcoxonMethodPhrase", () => {
  it("returns null for a null table", () => {
    expect(wilcoxonMethodPhrase(null)).toBeNull();
  });

  it("names the method when every row in the real fixture shares one real test", () => {
    const d = parseAnalysis(ROWS);
    expect(wilcoxonMethodPhrase(d.phase2)).toBe("via permutation (monte carlo, seeded)");
  });

  it("returns null rather than phrasing 'via degenerate ...' when every row is degenerate", () => {
    const payload = phase2Payload();
    for (const m of pairedMetrics(payload)) {
      (m["wilcoxon"] as Record<string, unknown>)["method"] = NO_TEST_METHOD;
    }
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(wilcoxonMethodPhrase(d.phase2)).toBeNull();
  });

  it("returns null rather than naming one method when the table's rows disagree", () => {
    const payload = phase2Payload();
    const metrics = pairedMetrics(payload);
    // Every other row keeps the fixture's "permutation (monte carlo, seeded)";
    // this one alone crosses into a different real method, as a future run
    // could if fewer pairs survived NULL pairwise deletion.
    (metrics[0]!["wilcoxon"] as Record<string, unknown>)["method"] = "permutation (exhaustive)";
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(wilcoxonMethodPhrase(d.phase2)).toBeNull();
  });

  it("returns null when one row is degenerate and the rest ran a real test", () => {
    const payload = phase2Payload();
    const metrics = pairedMetrics(payload);
    (metrics[0]!["wilcoxon"] as Record<string, unknown>)["method"] = NO_TEST_METHOD;
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(wilcoxonMethodPhrase(d.phase2)).toBeNull();
  });

  it("returns null when one row has no method, even though the rest agree", () => {
    const payload = phase2Payload();
    const metrics = pairedMetrics(payload);
    // Every other row keeps the fixture's "permutation (monte carlo, seeded)";
    // this one alone never reported a method. A missing method must not be
    // read as implicit agreement with the rows that did report one.
    delete (metrics[0]!["wilcoxon"] as Record<string, unknown>)["method"];
    const d = parseAnalysis([{ analysis: "phase2_paired", payload }]);
    expect(
      d.phase2!.rows.find((r) => r.metric === metrics[0]!["metric"])!.method,
    ).toBeNull();
    expect(wilcoxonMethodPhrase(d.phase2)).toBeNull();
  });
});
