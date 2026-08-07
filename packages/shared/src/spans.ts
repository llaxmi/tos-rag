/**
 * One retrieved chunk's location in a canonical document, as the 1-based
 * citation number the answer refers to it by. Offsets are UTF-16 code units —
 * the same unit `chunks.char_start`/`char_end` record and `String.slice` uses.
 */
export interface CitationSpan {
  index: number;
  charStart: number;
  charEnd: number;
}

export type DocSegment =
  | { kind: "text"; text: string }
  | { kind: "span"; text: string; index: number };

/**
 * Splits a canonical document into a flat, ordered run of plain and highlighted
 * segments so the source view can paint citations exactly where they sit.
 *
 * The guarantee callers rely on is that the segments reassemble the document
 * verbatim: `segments.map(s => s.text).join("") === text`. It is the same class
 * of promise as the chunker offset invariant, and for the same reason — the
 * highlights *are* the recorded offsets, so any silent drift here would paint
 * the wrong words with no error.
 *
 * The output is deliberately flat rather than nested. Two retrieved chunks can
 * share text, and a nested highlight has no visual design; an overlapping span
 * is therefore truncated to begin where the previous one ended, and dropped if
 * that leaves it empty.
 */
export function buildSpanSegments(
  text: string,
  spans: CitationSpan[],
): DocSegment[] {
  const segments: DocSegment[] = [];
  const ordered = spans
    .map((s) => ({
      index: s.index,
      charStart: Math.max(0, s.charStart),
      charEnd: Math.min(text.length, s.charEnd),
    }))
    .filter((s) => s.charStart < s.charEnd && s.charStart < text.length)
    .sort((a, b) => a.charStart - b.charStart || a.charEnd - b.charEnd);

  let cursor = 0;
  for (const span of ordered) {
    // Overlap: resume at the cursor, and skip entirely if nothing is left.
    const start = Math.max(span.charStart, cursor);
    if (start >= span.charEnd) continue;
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    segments.push({
      kind: "span",
      text: text.slice(start, span.charEnd),
      index: span.index,
    });
    cursor = span.charEnd;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}
