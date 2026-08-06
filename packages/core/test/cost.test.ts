import { describe, expect, it } from "vitest";
import { MODEL_IDS, costUsd, MODEL_PRICES } from "../src/index";

describe("costUsd", () => {
  it("prices an Opus run from its token counts", () => {
    // 2900 × $5/MTok = $0.0145; 70 × $25/MTok = $0.00175
    expect(costUsd(MODEL_IDS.opus, 2900, 70)).toBe(0.01625);
  });

  it("reproduces the measured Phase-2 Opus total", () => {
    // The whole Opus arm: 113,267 in / 4,223 out (docs/report-notes.md, 2026-08-04).
    // Rounding to 6dp is what makes this exact rather than 0.6719100000000001.
    expect(costUsd(MODEL_IDS.opus, 113_267, 4_223)).toBe(0.67191);
  });

  it("prices a locally served Llama run at zero", () => {
    expect(costUsd(MODEL_IDS.llama, 75_448, 1_422)).toBe(0);
  });

  it("throws on an unknown model rather than defaulting to zero", () => {
    expect(() => costUsd("gpt-9", 100, 100)).toThrow(/unknown model/i);
  });

  it("rejects negative token counts", () => {
    expect(() => costUsd(MODEL_IDS.opus, -1, 0)).toThrow(/token counts/i);
  });

  it("publishes a price for every generator the experiment ran", () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([MODEL_IDS.opus, MODEL_IDS.llama].sort());
  });
});
