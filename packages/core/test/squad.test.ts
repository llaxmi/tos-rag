import { describe, expect, test } from "vitest";
import { normalizeAnswer, squadScore } from "../src/index";

describe("normalizeAnswer (official SQuAD normalization)", () => {
  test("lowercases, strips punctuation and articles, collapses whitespace", () => {
    expect(normalizeAnswer("The  quick, brown fox!")).toBe("quick brown fox");
    expect(normalizeAnswer("An Apple a Day")).toBe("apple day");
  });

  test("removes only standalone articles, not substrings", () => {
    expect(normalizeAnswer("theatre and analysis")).toBe("theatre and analysis");
  });

  test("handles empty and punctuation-only strings", () => {
    expect(normalizeAnswer("")).toBe("");
    expect(normalizeAnswer("...!?")).toBe("");
  });
});

describe("squadScore", () => {
  test("exact match after normalization gives em=1, f1=1", () => {
    const s = squadScore("The 30 days notice", "30 days' notice");
    expect(s.em).toBe(1);
    expect(s.f1).toBeCloseTo(1);
  });

  test("partial overlap gives fractional f1, em=0", () => {
    // pred tokens: {30, days}; gold tokens: {30, days, written, notice}
    const s = squadScore("30 days", "30 days written notice");
    expect(s.em).toBe(0);
    // precision 2/2, recall 2/4 -> f1 = 2 * 1 * 0.5 / 1.5 = 2/3
    expect(s.f1).toBeCloseTo(2 / 3);
  });

  test("no overlap gives 0/0", () => {
    const s = squadScore("blue", "thirty days");
    expect(s.em).toBe(0);
    expect(s.f1).toBe(0);
  });

  test("both empty after normalization -> em=1, f1=1 (official edge case)", () => {
    const s = squadScore("the", "a");
    expect(s.em).toBe(1);
    expect(s.f1).toBe(1);
  });

  test("one empty after normalization -> em=0, f1=0", () => {
    const s = squadScore("the", "thirty days");
    expect(s.em).toBe(0);
    expect(s.f1).toBe(0);
  });

  test("repeated tokens are counted as a multiset", () => {
    // pred {very, very, good}, gold {very, good}
    // overlap = min counts = very:1, good:1 = 2; P = 2/3, R = 2/2
    const s = squadScore("very very good", "very good");
    expect(s.f1).toBeCloseTo((2 * (2 / 3) * 1) / (2 / 3 + 1));
  });
});
