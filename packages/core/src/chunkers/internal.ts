import type { Chunk, Range, TokenCounter } from "../types";

export function toChunks(
  text: string,
  ranges: Range[],
  countTokens: TokenCounter,
): Chunk[] {
  return ranges.map(([charStart, charEnd]) => {
    const t = text.slice(charStart, charEnd);
    return { charStart, charEnd, text: t, tokenCount: countTokens(t) };
  });
}

/**
 * Pack [start, end) into contiguous slices each within the token budget.
 * Prefers whitespace boundaries; splits mid-word only when a single word
 * exceeds the budget. Assumes countTokens is monotonic in slice length.
 */
export function packByBudget(
  text: string,
  start: number,
  end: number,
  maxTokens: number,
  countTokens: TokenCounter,
): Range[] {
  const out: Range[] = [];
  let s = start;
  while (s < end) {
    if (countTokens(text.slice(s, end)) <= maxTokens) {
      out.push([s, end]);
      break;
    }
    // largest e with count(text[s, e)) <= maxTokens; always make progress
    let lo = s + 1;
    let hi = end;
    let best = s + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (countTokens(text.slice(s, mid)) <= maxTokens) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let e = best;
    const isWs = (i: number) => /\s/.test(text[i] ?? " ");
    if (e < end && !isWs(e) && !isWs(e - 1)) {
      let b = e - 1;
      while (b > s && !isWs(b - 1)) b--;
      if (b > s) e = b;
    }
    out.push([s, e]);
    s = e;
  }
  return out;
}

/**
 * Greedily pack contiguous units (sentences, sections, …) into the budget.
 * Oversized single units fall back to packByBudget. Units must tile the range.
 */
export function packUnits(
  text: string,
  units: Range[],
  maxTokens: number,
  countTokens: TokenCounter,
): Range[] {
  const out: Range[] = [];
  let accStart = -1;
  let accEnd = -1;
  const flush = () => {
    if (accStart >= 0) out.push([accStart, accEnd]);
    accStart = -1;
  };
  for (const [us, ue] of units) {
    if (countTokens(text.slice(us, ue)) > maxTokens) {
      flush();
      out.push(...packByBudget(text, us, ue, maxTokens, countTokens));
      continue;
    }
    if (accStart < 0) {
      accStart = us;
      accEnd = ue;
    } else if (countTokens(text.slice(accStart, ue)) <= maxTokens) {
      accEnd = ue;
    } else {
      flush();
      accStart = us;
      accEnd = ue;
    }
  }
  flush();
  return out;
}

const SEPARATORS = ["\n\n", "\n"] as const;

/**
 * Recursive character splitting over a separator hierarchy, offsets preserved.
 * Separator runs stay attached to the preceding piece so pieces tile the range.
 */
export function splitRecursiveRange(
  text: string,
  start: number,
  end: number,
  sepIdx: number,
  maxTokens: number,
  countTokens: TokenCounter,
): Range[] {
  if (countTokens(text.slice(start, end)) <= maxTokens) return [[start, end]];
  if (sepIdx >= SEPARATORS.length) {
    return packByBudget(text, start, end, maxTokens, countTokens);
  }
  const sep = SEPARATORS[sepIdx]!;
  const pieces: Range[] = [];
  let s = start;
  let i = start;
  while (i <= end - sep.length) {
    if (text.startsWith(sep, i)) {
      let j = i;
      while (j <= end - sep.length && text.startsWith(sep, j)) j += sep.length;
      pieces.push([s, j]);
      s = j;
      i = j;
    } else {
      i++;
    }
  }
  if (s < end) pieces.push([s, end]);
  if (pieces.length <= 1) {
    return splitRecursiveRange(text, start, end, sepIdx + 1, maxTokens, countTokens);
  }
  const out: Range[] = [];
  let accStart = -1;
  let accEnd = -1;
  const flush = () => {
    if (accStart >= 0) out.push([accStart, accEnd]);
    accStart = -1;
  };
  for (const [ps, pe] of pieces) {
    if (countTokens(text.slice(ps, pe)) > maxTokens) {
      flush();
      out.push(...splitRecursiveRange(text, ps, pe, sepIdx + 1, maxTokens, countTokens));
    } else if (accStart < 0) {
      accStart = ps;
      accEnd = pe;
    } else if (countTokens(text.slice(accStart, pe)) <= maxTokens) {
      accEnd = pe;
    } else {
      flush();
      accStart = ps;
      accEnd = pe;
    }
  }
  flush();
  return out;
}

const ABBREVIATIONS =
  /\b(?:e\.g|i\.e|etc|vs|cf|Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Co|No|Sec|Art|Fig|St|approx)\.\s*$/;

/**
 * Sentence segmentation via Intl.Segmenter (native char offsets) with an
 * abbreviation-merge post-pass (PRD §8.3). Segments tile the input.
 */
export function sentenceRanges(text: string): Range[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const merged: Range[] = [];
  for (const s of segmenter.segment(text)) {
    const range: Range = [s.index, s.index + s.segment.length];
    const prev = merged[merged.length - 1];
    if (prev && ABBREVIATIONS.test(text.slice(prev[0], prev[1]))) {
      prev[1] = range[1];
    } else {
      merged.push(range);
    }
  }
  return merged;
}
