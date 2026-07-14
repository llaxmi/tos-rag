/**
 * Hand-rolled port of the official SQuAD evaluation script's answer
 * normalization and F1/EM (PRD §10.5) — lowercase, strip ASCII punctuation,
 * remove standalone articles, collapse whitespace.
 */

const PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

export function normalizeAnswer(s: string): string {
  const lower = s.toLowerCase();
  let noPunct = "";
  for (const ch of lower) {
    if (!PUNCTUATION.has(ch)) noPunct += ch;
  }
  const noArticles = noPunct.replace(/\b(a|an|the)\b/g, " ");
  return noArticles.split(/\s+/).filter(Boolean).join(" ");
}

export interface SquadScore {
  f1: number;
  em: number;
}

export function squadScore(prediction: string, goldAnswer: string): SquadScore {
  const predNorm = normalizeAnswer(prediction);
  const goldNorm = normalizeAnswer(goldAnswer);
  const em = predNorm === goldNorm ? 1 : 0;

  const predTokens = predNorm ? predNorm.split(" ") : [];
  const goldTokens = goldNorm ? goldNorm.split(" ") : [];
  // Official edge case: if either answer is empty, F1 is exact-match
  if (predTokens.length === 0 || goldTokens.length === 0) {
    return { f1: em, em };
  }

  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of predTokens) {
    const remaining = goldCounts.get(t) ?? 0;
    if (remaining > 0) {
      overlap++;
      goldCounts.set(t, remaining - 1);
    }
  }
  if (overlap === 0) return { f1: 0, em };

  const precision = overlap / predTokens.length;
  const recall = overlap / goldTokens.length;
  return { f1: (2 * precision * recall) / (precision + recall), em };
}
