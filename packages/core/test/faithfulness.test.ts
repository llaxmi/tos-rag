import { describe, expect, it } from "vitest";
import {
  buildDecomposePrompt,
  buildNliPrompt,
  buildRagPrompt,
  parseNliVerdicts,
  parseStatements,
  reconstructContext,
  scoreFaithfulness,
  type Judge,
} from "../src/index";

/** A judge that replies with a scripted queue and records the prompts it saw. */
function scriptedJudge(...replies: string[]): Judge & { prompts: string[] } {
  const queue = [...replies];
  const j = {
    prompts: [] as string[],
    async complete(prompt: string): Promise<string> {
      j.prompts.push(prompt);
      const next = queue.shift();
      if (next === undefined) throw new Error("judge called more times than scripted");
      return next;
    },
  };
  return j;
}

const CONTEXT = "GitHub gives at least 30 days' notice before changing fees.";

describe("buildDecomposePrompt", () => {
  it("includes the question and the answer, plus the decontextualization instruction", () => {
    const p = buildDecomposePrompt("How much notice does GitHub give?", "They give 30 days.");
    expect(p).toContain("How much notice does GitHub give?");
    expect(p).toContain("They give 30 days.");
    expect(p.toLowerCase()).toContain("self-contained");
    expect(p.toLowerCase()).toContain("pronoun");
  });
});

describe("parseStatements", () => {
  it("parses a JSON statement list", () => {
    expect(parseStatements('{"statements": ["A is true.", "B is true."]}')).toEqual([
      "A is true.",
      "B is true.",
    ]);
  });

  it("falls back to numbered lines when JSON is absent", () => {
    expect(parseStatements("1. A is true.\n2. B is true.")).toEqual([
      "A is true.",
      "B is true.",
    ]);
  });

  it("returns an empty list when the answer carries no factual claims", () => {
    expect(parseStatements('{"statements": []}')).toEqual([]);
  });

  it("drops blank entries rather than scoring them", () => {
    expect(parseStatements('{"statements": ["A.", "  ", ""]}')).toEqual(["A."]);
  });
});

describe("parseNliVerdicts", () => {
  it("parses a JSON verdict list", () => {
    expect(parseNliVerdicts('{"verdicts": ["supported", "unsupported"]}')).toEqual([
      true,
      false,
    ]);
  });

  it("falls back to scanning verdict words in order", () => {
    // \bsupported\b does not match inside "unsupported".
    expect(parseNliVerdicts("1: supported\n2: unsupported\n3: supported")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("throws when no verdict can be read at all", () => {
    expect(() => parseNliVerdicts("I could not decide.")).toThrow(/verdict/i);
  });

  it("does not silently default an unrecognized JSON token to unsupported", () => {
    // "yes" is neither verdict. Scoring it false would give a clean-looking
    // 0.000 for an answer that may be fully grounded, so it must fall through
    // to the word scan — which finds nothing here and throws.
    expect(() => parseNliVerdicts('{"verdicts": ["yes", "yes"]}')).toThrow(/verdict/i);
  });

  it("falls through to the word scan when the JSON has an unrecognized token but the reply also contains readable verdict words", () => {
    const text =
      '{"verdicts": ["yes", "no"]}\n' + "Statement 1: supported\nStatement 2: unsupported";
    expect(parseNliVerdicts(text)).toEqual([true, false]);
  });
});

describe("reconstructContext", () => {
  it("slices the stored spans out of the canonical text", () => {
    const canonicals = new Map([["github-tos", "0123456789abcdef"]]);
    const text = reconstructContext(
      [
        { doc_id: "github-tos", char_start: 0, char_end: 4, score: 0.9 },
        { doc_id: "github-tos", char_start: 10, char_end: 13, score: 0.8 },
      ],
      canonicals,
    );
    expect(text).toContain("0123");
    expect(text).toContain("abc");
  });

  it("rebuilds the context blocks exactly as the generation prompt laid them out", () => {
    // Faithfulness is only meaningful if it scores against what the generator
    // actually saw, so this pins the two layouts to stay identical.
    const canonical = "0123456789abcdef";
    const spans = [
      { doc_id: "github-tos", char_start: 0, char_end: 4, score: 0.9 },
      { doc_id: "github-tos", char_start: 10, char_end: 13, score: 0.8 },
    ];
    const generated = buildRagPrompt(
      "q?",
      spans.map((s) => ({
        docId: s.doc_id,
        charStart: s.char_start,
        charEnd: s.char_end,
        text: canonical.slice(s.char_start, s.char_end),
        score: s.score,
      })),
    );
    expect(generated).toContain(
      reconstructContext(spans, new Map([["github-tos", canonical]])),
    );
  });

  it("throws when a stored span names a document that was not loaded", () => {
    expect(() =>
      reconstructContext(
        [{ doc_id: "netflix-tou", char_start: 0, char_end: 4, score: 0.9 }],
        new Map([["github-tos", "0123456789"]]),
      ),
    ).toThrow(/netflix-tou/);
  });

  it("throws when a span runs past the end of the canonical text", () => {
    expect(() =>
      reconstructContext(
        [{ doc_id: "github-tos", char_start: 5, char_end: 99, score: 0.9 }],
        new Map([["github-tos", "0123456789"]]),
      ),
    ).toThrow(/out of range/i);
  });
});

describe("scoreFaithfulness", () => {
  it("scores supported over total", async () => {
    const judge = scriptedJudge(
      '{"statements": ["A.", "B.", "C."]}',
      '{"verdicts": ["supported", "supported", "unsupported"]}',
    );
    const r = await scoreFaithfulness(
      { question: "What does the answer say?", answer: "A. B. C.", context: CONTEXT },
      { judge },
    );
    expect(r).toEqual({ score: 2 / 3, supported: 2, total: 3 });
  });

  it("returns null for an abstention without calling the judge", async () => {
    const judge = scriptedJudge();
    const r = await scoreFaithfulness(
      { question: "Some question?", answer: "I don't know.", context: CONTEXT },
      { judge },
    );
    expect(r).toEqual({ score: null, reason: "abstention" });
    expect(judge.prompts).toHaveLength(0);
  });

  it("returns null when the answer decomposes to zero statements", async () => {
    const judge = scriptedJudge('{"statements": []}');
    const r = await scoreFaithfulness(
      { question: "Some question?", answer: "Hmm.", context: CONTEXT },
      { judge },
    );
    expect(r).toEqual({ score: null, reason: "no-statements" });
    expect(judge.prompts).toHaveLength(1);
  });

  it("retries the NLI call once when the verdict count does not match", async () => {
    const judge = scriptedJudge(
      '{"statements": ["A.", "B."]}',
      '{"verdicts": ["supported"]}', // one short
      '{"verdicts": ["supported", "supported"]}',
    );
    const r = await scoreFaithfulness(
      { question: "What does the answer say?", answer: "A. B.", context: CONTEXT },
      { judge },
    );
    expect(r).toEqual({ score: 1, supported: 2, total: 2 });
    expect(judge.prompts).toHaveLength(3);
  });

  it("throws when the verdict count is still wrong after the retry", async () => {
    const judge = scriptedJudge(
      '{"statements": ["A.", "B."]}',
      '{"verdicts": ["supported"]}',
      '{"verdicts": ["supported"]}',
    );
    await expect(
      scoreFaithfulness(
        { question: "What does the answer say?", answer: "A. B.", context: CONTEXT },
        { judge },
      ),
    ).rejects.toThrow(/2 statements/);
  });

  // Regression for a defect found on real Phase-2 rows. "90 days." has no
  // subject, so without the question it decomposes to a fragment the context
  // cannot support — 0.000 for an answer that is correct and fully grounded.
  // Asserting on the prompt the judge received is what makes this fail again
  // if the question is ever dropped from the decompose call.
  it("round-trips a terse answer to 1.0 when the judge decontextualizes it using the question", async () => {
    const question = "How long does GitHub retain account data after deletion?";
    const judge = scriptedJudge(
      '{"statements": ["GitHub retains account data for 90 days after deletion."]}',
      '{"verdicts": ["supported"]}',
    );
    const context = "GitHub retains account data for 90 days after deletion.";
    const r = await scoreFaithfulness(
      { question, answer: "90 days.", context },
      { judge },
    );
    expect(r).toEqual({ score: 1, supported: 1, total: 1 });
    expect(judge.prompts[0]).toContain(question);
  });
});

describe("buildNliPrompt", () => {
  it("numbers the statements and includes the context", () => {
    const p = buildNliPrompt(CONTEXT, ["A.", "B."]);
    expect(p).toContain(CONTEXT);
    expect(p).toContain("1. A.");
    expect(p).toContain("2. B.");
  });
});
