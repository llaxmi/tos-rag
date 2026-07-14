export type CitationSegment =
  | { kind: "text"; value: string }
  | { kind: "cite"; value: number };

export interface ParsedAnswer {
  segments: CitationSegment[];
  citedIds: number[];
}

/** Splits generated answers on [n] markers so citations can light up evidence. */
export function parseCitations(answer: string): ParsedAnswer {
  const segments: CitationSegment[] = [];
  const citedIds: number[] = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  for (const m of answer.matchAll(re)) {
    if (m.index > last) {
      segments.push({ kind: "text", value: answer.slice(last, m.index) });
    }
    const id = Number(m[1]);
    segments.push({ kind: "cite", value: id });
    if (!citedIds.includes(id)) citedIds.push(id);
    last = m.index + m[0].length;
  }
  if (last < answer.length) {
    segments.push({ kind: "text", value: answer.slice(last) });
  }
  return { segments, citedIds };
}
