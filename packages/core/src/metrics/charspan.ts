import type { DocSpan, Span } from "../types";

/** Merge overlapping/adjacent spans; returns spans sorted by start. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.charStart - b.charStart);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.charStart <= last.charEnd) {
      last.charEnd = Math.max(last.charEnd, s.charEnd);
    } else {
      out.push({ charStart: s.charStart, charEnd: s.charEnd });
    }
  }
  return out;
}

export interface CharSpanMetrics {
  precision: number;
  recall: number;
  hit: 0 | 1;
}

/**
 * LegalBench-RAG-style character-span retrieval metrics (PRD §10.1).
 * Retrieved spans are merged per document before counting (no double credit).
 * Returns null for unanswerable questions (no gold spans).
 */
export function charSpanMetrics(
  goldSpans: readonly DocSpan[],
  retrievedSpans: readonly DocSpan[],
): CharSpanMetrics | null {
  if (goldSpans.length === 0) return null;

  const byDoc = (spans: readonly DocSpan[]): Map<string, Span[]> => {
    const m = new Map<string, Span[]>();
    for (const s of spans) {
      const arr = m.get(s.docId) ?? [];
      arr.push(s);
      m.set(s.docId, arr);
    }
    for (const [k, v] of m) m.set(k, mergeSpans(v));
    return m;
  };

  const gold = byDoc(goldSpans);
  const retrieved = byDoc(retrievedSpans);

  let goldChars = 0;
  for (const spans of gold.values()) {
    for (const s of spans) goldChars += s.charEnd - s.charStart;
  }
  let retrievedChars = 0;
  for (const spans of retrieved.values()) {
    for (const s of spans) retrievedChars += s.charEnd - s.charStart;
  }

  let overlap = 0;
  for (const [docId, goldDocSpans] of gold) {
    const retrievedDocSpans = retrieved.get(docId) ?? [];
    for (const g of goldDocSpans) {
      for (const r of retrievedDocSpans) {
        overlap += Math.max(
          0,
          Math.min(g.charEnd, r.charEnd) - Math.max(g.charStart, r.charStart),
        );
      }
    }
  }

  return {
    precision: retrievedChars === 0 ? 0 : overlap / retrievedChars,
    recall: goldChars === 0 ? 0 : overlap / goldChars,
    hit: overlap > 0 ? 1 : 0,
  };
}
