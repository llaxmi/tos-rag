import { describe, expect, test } from "vitest";
import { charSpanMetrics, mergeSpans } from "../src/index";

describe("mergeSpans", () => {
  test("merges overlapping and adjacent spans", () => {
    expect(
      mergeSpans([
        { charStart: 10, charEnd: 20 },
        { charStart: 15, charEnd: 30 },
        { charStart: 30, charEnd: 40 },
        { charStart: 50, charEnd: 60 },
      ]),
    ).toEqual([
      { charStart: 10, charEnd: 40 },
      { charStart: 50, charEnd: 60 },
    ]);
  });

  test("sorts unordered input", () => {
    expect(
      mergeSpans([
        { charStart: 50, charEnd: 60 },
        { charStart: 10, charEnd: 20 },
      ]),
    ).toEqual([
      { charStart: 10, charEnd: 20 },
      { charStart: 50, charEnd: 60 },
    ]);
  });

  test("empty input", () => {
    expect(mergeSpans([])).toEqual([]);
  });
});

describe("charSpanMetrics (LegalBench-RAG style)", () => {
  test("perfect retrieval: single chunk covers the whole gold span exactly", () => {
    const m = charSpanMetrics(
      [{ docId: "d", charStart: 100, charEnd: 200 }],
      [{ docId: "d", charStart: 100, charEnd: 200 }],
    );
    expect(m).toEqual({ precision: 1, recall: 1, hit: 1 });
  });

  test("partial overlap computes character-level P/R", () => {
    // gold 100 chars [100,200); retrieved 200 chars [150,350) -> overlap 50
    const m = charSpanMetrics(
      [{ docId: "d", charStart: 100, charEnd: 200 }],
      [{ docId: "d", charStart: 150, charEnd: 350 }],
    );
    expect(m!.precision).toBeCloseTo(50 / 200);
    expect(m!.recall).toBeCloseTo(50 / 100);
    expect(m!.hit).toBe(1);
  });

  test("overlapping retrieved chunks are merged before counting (no double credit)", () => {
    // two retrieved chunks overlap each other over the gold span
    const m = charSpanMetrics(
      [{ docId: "d", charStart: 0, charEnd: 100 }],
      [
        { docId: "d", charStart: 0, charEnd: 80 },
        { docId: "d", charStart: 40, charEnd: 100 },
      ],
    );
    // merged retrieved = [0,100): overlap 100, retrieved chars 100
    expect(m!.precision).toBeCloseTo(1);
    expect(m!.recall).toBeCloseTo(1);
  });

  test("chunks from a different document never overlap gold spans", () => {
    const m = charSpanMetrics(
      [{ docId: "github-tos", charStart: 0, charEnd: 100 }],
      [{ docId: "netflix-tou", charStart: 0, charEnd: 100 }],
    );
    expect(m!.recall).toBe(0);
    expect(m!.hit).toBe(0);
  });

  test("unanswerable questions (no gold spans) return null", () => {
    expect(
      charSpanMetrics([], [{ docId: "d", charStart: 0, charEnd: 10 }]),
    ).toBeNull();
  });

  test("multiple gold spans aggregate overlap across spans", () => {
    // gold: [0,10) and [90,100) => 20 chars; retrieved [5,95) => 90 chars
    // overlap: 5 + 5 = 10
    const m = charSpanMetrics(
      [
        { docId: "d", charStart: 0, charEnd: 10 },
        { docId: "d", charStart: 90, charEnd: 100 },
      ],
      [{ docId: "d", charStart: 5, charEnd: 95 }],
    );
    expect(m!.precision).toBeCloseTo(10 / 90);
    expect(m!.recall).toBeCloseTo(10 / 20);
    expect(m!.hit).toBe(1);
  });
});
