import { describe, expect, it } from "vitest";
import {
  buildQuestionRecords,
  parseQuestionsJsonl,
  QuoteResolutionError,
  resolveQuoteSpan,
  type AuthoringEntry,
} from "../src/index";

describe("resolveQuoteSpan", () => {
  it("returns exact offsets for a verbatim substring", () => {
    const canon = "You must be at least 18 years of age to create an account.";
    const span = resolveQuoteSpan(canon, "at least 18 years of age");
    expect(canon.slice(span.char_start, span.char_end)).toBe("at least 18 years of age");
  });

  it("matches across author line-wraps (collapsed whitespace)", () => {
    // Canonical is one physical line; the author wrapped the quote.
    const canon = "GitHub does not target our Service to children under 13, and we do not permit them.";
    const wrapped = "does not target our\nService to children under 13";
    const span = resolveQuoteSpan(canon, wrapped);
    // Span indexes the ORIGINAL text, so the slice keeps the real single space.
    expect(canon.slice(span.char_start, span.char_end)).toBe(
      "does not target our Service to children under 13",
    );
  });

  it("matches when the canonical uses smart apostrophes but the author typed ASCII", () => {
    const canon = "the Extra Member’s immediate loss of access"; // curly ’
    const span = resolveQuoteSpan(canon, "Extra Member's immediate loss"); // straight '
    expect(canon.slice(span.char_start, span.char_end)).toBe(
      "Extra Member’s immediate loss",
    );
  });

  it("matches text the author quoted without its Markdown link target", () => {
    const canon = "please contact us by emailing [copyright@github.com](mailto:copyright@github.com) today.";
    const span = resolveQuoteSpan(canon, "by emailing copyright@github.com today");
    // The real span includes the link markup — it is a raw character range.
    expect(canon.slice(span.char_start, span.char_end)).toBe(
      "by emailing [copyright@github.com](mailto:copyright@github.com) today",
    );
  });

  it("throws with a near-miss hint when the quote is not found", () => {
    const canon = "GitHub gives at least 30 days notice before changes.";
    expect(() => resolveQuoteSpan(canon, "at least 60 days notice")).toThrowError(
      /not found/i,
    );
  });

  it("throws when the quote is ambiguous (appears twice)", () => {
    const canon = "the Service. Use of the Service. And more of the Service.";
    expect(() => resolveQuoteSpan(canon, "the Service")).toThrowError(/ambiguous/i);
  });
});

describe("buildQuestionRecords", () => {
  const canon =
    "You must be at least 18 years of age. The Service is governed by the laws of Singapore.";

  const answerable: AuthoringEntry = {
    id: "netflix-q01",
    qtype: "factual",
    question: "Minimum age?",
    expected_answer: "18.",
    phase1: true,
    gold_quotes: ["at least 18 years of age"],
  };

  const unanswerable: AuthoringEntry = {
    id: "netflix-q02",
    qtype: "unanswerable",
    question: "Exact price?",
    expected_answer: "I don't know",
    phase1: false,
    gold_quotes: [],
  };

  it("produces PRD §6 records with resolved gold_spans", () => {
    const [rec] = buildQuestionRecords("netflix-tou", canon, [answerable]);
    expect(rec!.doc_id).toBe("netflix-tou");
    expect(rec!.gold_spans).toHaveLength(1);
    expect(canon.slice(rec!.gold_spans[0]!.char_start, rec!.gold_spans[0]!.char_end)).toBe(
      "at least 18 years of age",
    );
  });

  it("passes unanswerable questions through with empty spans", () => {
    const [rec] = buildQuestionRecords("netflix-tou", canon, [unanswerable]);
    expect(rec!.gold_spans).toEqual([]);
    expect(rec!.qtype).toBe("unanswerable");
  });

  it("sorts multiple gold_spans by position", () => {
    const multi: AuthoringEntry = {
      ...answerable,
      qtype: "multi_clause",
      gold_quotes: ["laws of Singapore", "at least 18 years"],
    };
    const [rec] = buildQuestionRecords("netflix-tou", canon, [multi]);
    expect(rec!.gold_spans[0]!.char_start).toBeLessThan(rec!.gold_spans[1]!.char_start);
  });

  it("rejects an unanswerable question that carries quotes", () => {
    const bad = { ...unanswerable, gold_quotes: ["at least 18 years of age"] };
    expect(() => buildQuestionRecords("netflix-tou", canon, [bad])).toThrowError(
      QuoteResolutionError,
    );
  });

  it("rejects an unanswerable question whose answer is not the abstention text", () => {
    const bad = { ...unanswerable, expected_answer: "It is free." };
    expect(() => buildQuestionRecords("netflix-tou", canon, [bad])).toThrowError(
      /abstention|I don't know/i,
    );
  });

  it("rejects an answerable question with no gold_quotes", () => {
    const bad = { ...answerable, gold_quotes: [] };
    expect(() => buildQuestionRecords("netflix-tou", canon, [bad])).toThrowError(
      /at least one gold_quote/i,
    );
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      buildQuestionRecords("netflix-tou", canon, [answerable, answerable]),
    ).toThrowError(/duplicate id/i);
  });

  it("rejects an unknown qtype", () => {
    const bad = { ...answerable, qtype: "single-clause" };
    expect(() => buildQuestionRecords("netflix-tou", canon, [bad])).toThrowError(
      /invalid qtype/i,
    );
  });
});

describe("parseQuestionsJsonl", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const answerable = {
    id: "github-q01",
    doc_id: "github-tos",
    qtype: "factual",
    question: "Q?",
    expected_answer: "A.",
    gold_spans: [{ char_start: 10, char_end: 20 }],
    phase1: true,
  };
  const unanswerable = {
    id: "github-q02",
    doc_id: "github-tos",
    qtype: "unanswerable",
    question: "Q?",
    expected_answer: "I don't know",
    gold_spans: [],
    phase1: false,
  };

  it("parses valid records and ignores blank lines", () => {
    const text = `${line(answerable)}\n\n${line(unanswerable)}\n`;
    const records = parseQuestionsJsonl(text);
    expect(records).toHaveLength(2);
    expect(records[0]!.id).toBe("github-q01");
    expect(records[1]!.gold_spans).toEqual([]);
  });

  it("throws with the 1-based line number on malformed JSON", () => {
    const text = `${line(answerable)}\n{not json}\n`;
    expect(() => parseQuestionsJsonl(text)).toThrowError(/line 2/);
  });

  it("throws with the line number on a schema violation", () => {
    const bad = { ...answerable, qtype: "single-clause" };
    expect(() => parseQuestionsJsonl(`${line(bad)}\n`)).toThrowError(/line 1/);
  });

  it("returns an empty array for an empty file", () => {
    expect(parseQuestionsJsonl("\n\n")).toEqual([]);
  });
});
