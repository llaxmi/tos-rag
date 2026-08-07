import { describe, expect, test } from "vitest";
import { formatMeanCI, formatMs, formatUSD, formatUnitUSD } from "../src/format";
import { heatColor, linearScale, SEQ_RAMP } from "../src/scale";
import { parseCitations } from "../src/citations";

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

describe("formatUnitUSD", () => {
  test("keeps four places for a unit rate above a cent", () => {
    // formatUSD would give "$0.02" here, losing the precision the report cites.
    expect(formatUnitUSD(0.0232)).toBe("$0.0232");
    expect(formatUnitUSD(0.134382)).toBe("$0.1344");
  });
  test("renders a free arm as an exact zero, not a blank", () => {
    expect(formatUnitUSD(0)).toBe("$0.0000");
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
