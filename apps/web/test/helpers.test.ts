import { describe, expect, test } from "vitest";
import { formatMeanCI, formatMs, formatUSD } from "../src/lib/format";
import { boxStats, heatColor, linearScale, SEQ_RAMP } from "../src/lib/scale";
import { parseCitations } from "../src/lib/citations";

describe("formatMeanCI", () => {
  test("renders mean with bracketed 95% CI to 2 decimals", () => {
    expect(formatMeanCI(0.8234, [0.761, 0.882])).toBe("0.82 [0.76, 0.88]");
  });
  test("renders mean alone when CI missing", () => {
    expect(formatMeanCI(0.5)).toBe("0.50");
  });
});

describe("formatMs", () => {
  test("keeps milliseconds under a second", () => {
    expect(formatMs(350)).toBe("350 ms");
  });
  test("switches to seconds at 1000", () => {
    expect(formatMs(1240)).toBe("1.24 s");
  });
});

describe("formatUSD", () => {
  test("uses 4 significant decimals for sub-cent amounts", () => {
    expect(formatUSD(0.00423)).toBe("$0.0042");
  });
  test("uses 2 decimals for larger amounts", () => {
    expect(formatUSD(1.5)).toBe("$1.50");
  });
});

describe("linearScale", () => {
  test("maps domain to range linearly", () => {
    const s = linearScale([0, 10], [0, 100]);
    expect(s(5)).toBe(50);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
  });
  test("degenerate domain maps to range start", () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(s(5)).toBe(0);
  });
});

describe("heatColor (sequential blue ramp)", () => {
  test("minimum maps to the lightest step, maximum to the darkest", () => {
    expect(heatColor(0, 0, 1)).toBe(SEQ_RAMP[0]);
    expect(heatColor(1, 0, 1)).toBe(SEQ_RAMP[SEQ_RAMP.length - 1]);
  });
  test("midpoint maps to a middle step", () => {
    const c = heatColor(0.5, 0, 1);
    const idx = SEQ_RAMP.indexOf(c);
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(SEQ_RAMP.length - 1);
  });
  test("degenerate range uses the middle of the ramp", () => {
    expect(heatColor(0.7, 0.7, 0.7)).toBe(SEQ_RAMP[Math.floor(SEQ_RAMP.length / 2)]);
  });
});

describe("boxStats", () => {
  test("computes five-number summary with interpolated quartiles", () => {
    const s = boxStats([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(8);
    expect(s.median).toBe(4.5);
    expect(s.q1).toBeCloseTo(2.75);
    expect(s.q3).toBeCloseTo(6.25);
  });
  test("single value collapses the box", () => {
    const s = boxStats([42]);
    expect(s).toEqual({ min: 42, q1: 42, median: 42, q3: 42, max: 42 });
  });
});

describe("parseCitations", () => {
  test("splits answer text into text and citation segments", () => {
    const parsed = parseCitations("At least 30 days [1], see also [2].");
    expect(parsed.segments).toEqual([
      { kind: "text", value: "At least 30 days " },
      { kind: "cite", value: 1 },
      { kind: "text", value: ", see also " },
      { kind: "cite", value: 2 },
      { kind: "text", value: "." },
    ]);
    expect(parsed.citedIds).toEqual([1, 2]);
  });
  test("answer without citations is a single text segment", () => {
    const parsed = parseCitations("I don't know");
    expect(parsed.segments).toEqual([{ kind: "text", value: "I don't know" }]);
    expect(parsed.citedIds).toEqual([]);
  });
  test("deduplicates repeated citations in citedIds", () => {
    const parsed = parseCitations("A [1] and B [1].");
    expect(parsed.citedIds).toEqual([1]);
  });
});
