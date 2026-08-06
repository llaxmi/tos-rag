import { describe, expect, test } from "vitest";
import {
  ABSTENTION_TEXT,
  buildRagPrompt,
  CHUNK_SIZES,
  cosineSimilarity,
  isAbstention,
  PHASE1_WINNER,
  QuestionRecordSchema,
  STRATEGIES,
} from "../src/index";

describe("cosineSimilarity", () => {
  test("identical vectors -> 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  test("orthogonal vectors -> 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  test("opposite vectors -> -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  test("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
  });
});

describe("abstention protocol", () => {
  test("exact phrase, case-insensitive, surrounding whitespace ignored", () => {
    expect(isAbstention("I don't know")).toBe(true);
    expect(isAbstention("  i don't know \n")).toBe(true);
    expect(isAbstention("I don't know, but maybe 30 days.")).toBe(false);
  });
  test("trailing sentence punctuation is not meaningful (PRD §10.3 amendment)", () => {
    // Llama emits "I don't know." and Opus "I don't know"; scoring the same
    // behaviour differently on a full stop is what this guards against.
    expect(isAbstention("I don't know.")).toBe(true);
    expect(isAbstention("I don't know!")).toBe(true);
    expect(isAbstention("  I don't know...  ")).toBe(true);
    // Stripping trailing punctuation must not swallow a qualified answer.
    expect(isAbstention("I don't know, but maybe 30 days")).toBe(false);
  });
  test("canonical abstention text matches its own detector", () => {
    expect(isAbstention(ABSTENTION_TEXT)).toBe(true);
  });
});

describe("buildRagPrompt", () => {
  const chunks = [
    { docId: "github-tos", charStart: 10, charEnd: 90, text: "Fees are due in 30 days.", score: 0.91 },
    { docId: "netflix-tou", charStart: 5, charEnd: 55, text: "You may cancel anytime.", score: 0.72 },
  ];

  test("numbers chunks and tags them with doc and char range", () => {
    const p = buildRagPrompt("When are fees due?", chunks);
    expect(p).toContain("[1] [github-tos §10–90]");
    expect(p).toContain("[2] [netflix-tou §5–55]");
    expect(p).toContain("Fees are due in 30 days.");
    expect(p).toContain("Question: When are fees due?");
  });

  test("contains the exact abstention instruction", () => {
    const p = buildRagPrompt("q", chunks);
    expect(p).toContain("reply exactly: I don't know");
  });
});

describe("QuestionRecordSchema", () => {
  const valid = {
    id: "github-q01",
    doc_id: "github-tos",
    qtype: "factual",
    question: "How much notice before fee changes?",
    expected_answer: "At least 30 days.",
    gold_spans: [{ char_start: 100, char_end: 200 }],
    phase1: true,
  };

  test("accepts a valid record", () => {
    expect(QuestionRecordSchema.parse(valid)).toEqual(valid);
  });

  test("rejects unknown qtype", () => {
    expect(() =>
      QuestionRecordSchema.parse({ ...valid, qtype: "essay" }),
    ).toThrow();
  });

  test("rejects spans with end <= start", () => {
    expect(() =>
      QuestionRecordSchema.parse({
        ...valid,
        gold_spans: [{ char_start: 200, char_end: 200 }],
      }),
    ).toThrow();
  });

  test("unanswerable questions may have empty gold_spans", () => {
    const rec = {
      ...valid,
      qtype: "unanswerable",
      gold_spans: [],
      expected_answer: "I don't know",
    };
    expect(QuestionRecordSchema.parse(rec)).toEqual(rec);
  });
});

describe("PHASE1_WINNER", () => {
  test("is the Phase 1 winning config (sentence:512, PRD §7)", () => {
    expect(PHASE1_WINNER).toEqual({ strategy: "sentence", chunkSize: 512 });
  });

  test("names a real strategy and a frozen chunk size", () => {
    expect(STRATEGIES).toContain(PHASE1_WINNER.strategy);
    expect(CHUNK_SIZES).toContain(PHASE1_WINNER.chunkSize);
  });
});
