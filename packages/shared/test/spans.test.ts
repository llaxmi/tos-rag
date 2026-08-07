import { describe, expect, test } from "vitest";
import { buildSpanSegments, type CitationSpan } from "../src/spans";

const TEXT = "Alpha bravo charlie delta echo.";
//           0123456789...
//           "Alpha " 0-6, "bravo " 6-12, "charlie " 12-20, "delta " 20-26

/** The invariant: rendering the segments must reproduce the document exactly. */
function reassemble(text: string, spans: CitationSpan[]): string {
  return buildSpanSegments(text, spans)
    .map((s) => s.text)
    .join("");
}

describe("buildSpanSegments", () => {
  test("no spans yields one text segment equal to the input", () => {
    expect(buildSpanSegments(TEXT, [])).toEqual([{ kind: "text", text: TEXT }]);
  });

  test("empty document yields no segments", () => {
    expect(buildSpanSegments("", [])).toEqual([]);
  });

  test("a single span splits into text, span, text", () => {
    expect(
      buildSpanSegments(TEXT, [{ index: 1, charStart: 6, charEnd: 11 }]),
    ).toEqual([
      { kind: "text", text: "Alpha " },
      { kind: "span", text: "bravo", index: 1 },
      { kind: "text", text: " charlie delta echo." },
    ]);
  });

  test("segments always reassemble to the original text", () => {
    const cases: CitationSpan[][] = [
      [],
      [{ index: 1, charStart: 0, charEnd: 5 }],
      [{ index: 1, charStart: 6, charEnd: 11 }, { index: 2, charStart: 20, charEnd: 25 }],
      [{ index: 1, charStart: 0, charEnd: TEXT.length }],
      [{ index: 2, charStart: 12, charEnd: 19 }, { index: 1, charStart: 0, charEnd: 5 }],
    ];
    for (const spans of cases) {
      expect(reassemble(TEXT, spans)).toBe(TEXT);
    }
  });

  test("spans passed out of order match sorted input", () => {
    const a: CitationSpan[] = [
      { index: 2, charStart: 12, charEnd: 19 },
      { index: 1, charStart: 0, charEnd: 5 },
    ];
    const b: CitationSpan[] = [
      { index: 1, charStart: 0, charEnd: 5 },
      { index: 2, charStart: 12, charEnd: 19 },
    ];
    expect(buildSpanSegments(TEXT, a)).toEqual(buildSpanSegments(TEXT, b));
  });

  test("touching spans produce adjacent span segments with no empty text between", () => {
    const segs = buildSpanSegments(TEXT, [
      { index: 1, charStart: 0, charEnd: 6 },
      { index: 2, charStart: 6, charEnd: 12 },
    ]);
    expect(segs).toEqual([
      { kind: "span", text: "Alpha ", index: 1 },
      { kind: "span", text: "bravo ", index: 2 },
      { kind: "text", text: "charlie delta echo." },
    ]);
    expect(segs.every((s) => s.text.length > 0)).toBe(true);
  });

  test("an overlapping span is truncated to start where the previous one ended", () => {
    const segs = buildSpanSegments(TEXT, [
      { index: 1, charStart: 0, charEnd: 11 },
      { index: 2, charStart: 6, charEnd: 19 },
    ]);
    expect(segs).toEqual([
      { kind: "span", text: "Alpha bravo", index: 1 },
      { kind: "span", text: " charlie", index: 2 },
      { kind: "text", text: " delta echo." },
    ]);
    expect(reassemble(TEXT, [
      { index: 1, charStart: 0, charEnd: 11 },
      { index: 2, charStart: 6, charEnd: 19 },
    ])).toBe(TEXT);
  });

  test("a span fully swallowed by an earlier one is dropped", () => {
    expect(
      buildSpanSegments(TEXT, [
        { index: 1, charStart: 0, charEnd: 19 },
        { index: 2, charStart: 6, charEnd: 11 },
      ]),
    ).toEqual([
      { kind: "span", text: "Alpha bravo charlie", index: 1 },
      { kind: "text", text: " delta echo." },
    ]);
  });

  test("a span ending at the document end emits no trailing empty text segment", () => {
    const segs = buildSpanSegments(TEXT, [
      { index: 1, charStart: 26, charEnd: TEXT.length },
    ]);
    expect(segs).toEqual([
      { kind: "text", text: "Alpha bravo charlie delta " },
      { kind: "span", text: "echo.", index: 1 },
    ]);
  });

  test("out-of-range, inverted and zero-length spans are dropped", () => {
    expect(
      buildSpanSegments(TEXT, [
        { index: 1, charStart: -5, charEnd: -1 },
        { index: 2, charStart: 900, charEnd: 950 },
        { index: 3, charStart: 10, charEnd: 10 },
        { index: 4, charStart: 12, charEnd: 6 },
      ]),
    ).toEqual([{ kind: "text", text: TEXT }]);
  });

  test("a span overhanging the end is clamped to the document length", () => {
    expect(
      buildSpanSegments(TEXT, [{ index: 1, charStart: 26, charEnd: 999 }]),
    ).toEqual([
      { kind: "text", text: "Alpha bravo charlie delta " },
      { kind: "span", text: "echo.", index: 1 },
    ]);
  });
});
