import { describe, expect, it, vi } from "vitest";
import {
  buildCragPrompt,
  evaluateRun,
  parseCragVerdict,
  type EvaluateInput,
  type Judge,
} from "../src/index";

/** A judge that records how many times it was called and returns a canned reply. */
function fakeJudge(reply: string): Judge & { calls: number } {
  const j = {
    calls: 0,
    async complete(_prompt: string): Promise<string> {
      j.calls++;
      return reply;
    },
  };
  return j;
}

const GOLD = [{ docId: "github-tos", charStart: 100, charEnd: 200 }];
const RETRIEVED = [{ docId: "github-tos", charStart: 150, charEnd: 250 }];

const base: EvaluateInput = {
  question: "How much notice does GitHub give before fee changes?",
  expectedAnswer: "At least 30 days' advance notice.",
  answer: "GitHub gives a minimum of 30 days before price changes.",
  goldSpans: GOLD,
  retrieved: RETRIEVED,
};

describe("parseCragVerdict", () => {
  it("parses a well-formed JSON verdict", () => {
    const v = parseCragVerdict('{"explanation": "same meaning", "score": "accurate"}');
    expect(v).toEqual({ score: 1, explanation: "same meaning" });
  });

  it("parses an incorrect verdict", () => {
    expect(parseCragVerdict('{"score":"incorrect","explanation":"wrong age"}').score).toBe(-1);
  });

  it("recovers from surrounding prose via the JSON substring", () => {
    const v = parseCragVerdict('Here is my grade:\n{"explanation":"ok","score":"accurate"}\nThanks');
    expect(v.score).toBe(1);
  });

  it("falls back to a word-boundary regex when JSON is malformed", () => {
    expect(parseCragVerdict("explanation: the answer is incorrect.").score).toBe(-1);
    expect(parseCragVerdict("verdict = accurate").score).toBe(1);
  });

  it("does not mistake 'inaccurate' for an accurate verdict", () => {
    // 'inaccurate' has no word-boundary 'accurate'; only 'incorrect' should hit.
    expect(parseCragVerdict("the answer is incorrect and inaccurate").score).toBe(-1);
  });

  it("throws when the verdict is genuinely unresolvable", () => {
    expect(() => parseCragVerdict("I am not sure about this one.")).toThrowError(/could not parse/i);
  });

  it("builds a prompt containing the three inputs", () => {
    const p = buildCragPrompt("Q?", "REF", "GEN");
    expect(p).toContain("Q?");
    expect(p).toContain("REF");
    expect(p).toContain("GEN");
  });
});

describe("evaluateRun", () => {
  it("assembles deterministic metrics from the existing helpers", async () => {
    const judge = fakeJudge('{"score":"accurate","explanation":"ok"}');
    const scores = await evaluateRun(base, { judge });
    // Overlap of [150,200) = 50 chars; gold 100, retrieved 100.
    expect(scores.char_recall).toBeCloseTo(0.5);
    expect(scores.char_precision).toBeCloseTo(0.5);
    expect(scores.hit_at_8).toBe(1);
    expect(scores.squad_f1).toBeGreaterThan(0);
    expect(scores.faithfulness).toBeNull();
    expect(scores.cosine_sim).toBeNull();
    expect(scores.cost_usd).toBeNull();
  });

  it("scores an abstention as Missing (0) without calling the judge", async () => {
    const judge = fakeJudge("SHOULD NOT BE CALLED");
    const scores = await evaluateRun({ ...base, answer: "I don't know" }, { judge });
    expect(scores.crag_score).toBe(0);
    expect(scores.judge_explanation).toBe("abstained");
    expect(judge.calls).toBe(0);
  });

  it("scores a normalized exact match as Accurate (+1) without calling the judge", async () => {
    const judge = fakeJudge("SHOULD NOT BE CALLED");
    const scores = await evaluateRun(
      { ...base, answer: "at least 30 days' advance notice" },
      { judge },
    );
    expect(scores.crag_score).toBe(1);
    expect(scores.judge_explanation).toBe("exact match");
    expect(judge.calls).toBe(0);
  });

  it("defers to the judge for a paraphrase and records its verdict", async () => {
    const judge = fakeJudge('{"score":"accurate","explanation":"same meaning"}');
    const spy = vi.spyOn(judge, "complete");
    const scores = await evaluateRun(base, { judge });
    expect(scores.crag_score).toBe(1);
    expect(scores.judge_explanation).toBe("same meaning");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("records an incorrect judge verdict as −1", async () => {
    const judge = fakeJudge('{"score":"incorrect","explanation":"wrong"}');
    const scores = await evaluateRun(base, { judge });
    expect(scores.crag_score).toBe(-1);
  });

  it("returns null retrieval metrics for unanswerable questions (no gold spans)", async () => {
    const judge = fakeJudge("SHOULD NOT BE CALLED");
    const scores = await evaluateRun(
      { ...base, goldSpans: [], expectedAnswer: "I don't know", answer: "I don't know" },
      { judge },
    );
    expect(scores.char_precision).toBeNull();
    expect(scores.char_recall).toBeNull();
    expect(scores.hit_at_8).toBeNull();
    expect(scores.crag_score).toBe(0); // correct abstention
    expect(judge.calls).toBe(0);
  });

  it("propagates an unparseable judge response as an error (no silent default)", async () => {
    const judge = fakeJudge("I cannot decide.");
    await expect(evaluateRun(base, { judge })).rejects.toThrowError(/could not parse/i);
  });
});
