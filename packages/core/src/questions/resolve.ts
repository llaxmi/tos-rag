import { ABSTENTION_TEXT } from "../prompts";
import { QTYPES, QuestionRecordSchema, type QuestionRecord } from "../schemas";

/**
 * Gold-span resolution: verbatim author quotes → canonical character offsets
 * (PRD §6). The pure half of `build-questions`, testable with no I/O.
 *
 * Authors write questions in YAML and quote the evidence by hand. Three things
 * make a raw `indexOf` fail against the canonical Markdown, all proven against
 * the real corpus:
 *
 *   1. Quotes are line-wrapped for readability, so they contain newlines the
 *      canonical does not (single physical lines). → collapse whitespace.
 *   2. The canonical uses typographic apostrophes/quotes (’ “ ”) and dashes
 *      (— –); authors type ASCII ones. → unify to ASCII.
 *   3. The canonical embeds Markdown links `[text](url)`; authors quote only the
 *      visible `text`. → match against `text`, drop the target.
 *
 * Matching happens on a normalized projection of both strings, but the returned
 * span always indexes the ORIGINAL canonical, in UTF-16 code units (the unit the
 * chunker offset invariant is defined in — never Postgres codepoints).
 */

/** One character of the normalized projection and where it came from. */
interface NormChar {
  /** The normalized character. */
  ch: string;
  /** Inclusive start offset of its source in the ORIGINAL text (UTF-16). */
  start: number;
  /** Exclusive end offset of its source in the ORIGINAL text (UTF-16). */
  end: number;
}

const SMART_MAP: Record<string, string> = {
  "’": "'", // ’ right single quote
  "‘": "'", // ‘ left single quote
  "“": '"', // “ left double quote
  "”": '"', // ” right double quote
  "—": "-", // — em dash
  "–": "-", // – en dash
};

/**
 * Projects `text` to a normalized character stream, each element carrying the
 * source range it came from. Whitespace runs collapse to a single space; leading
 * and trailing whitespace is dropped; smart punctuation is folded to ASCII;
 * Markdown links contribute only their visible text.
 */
function scan(text: string, base = 0): NormChar[] {
  const out: NormChar[] = [];
  let i = 0;
  const lastIsSpace = () => out.length > 0 && out[out.length - 1]!.ch === " ";

  while (i < text.length) {
    const c = text[i]!;

    // Markdown link: [visible](target) → contribute only `visible`.
    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren !== -1) {
          const inner = scan(text.slice(i + 1, close), base + i + 1);
          out.push(...inner);
          i = paren + 1;
          continue;
        }
      }
    }

    if (/\s/.test(c)) {
      // Collapse: emit a single space only between content, never leading.
      if (out.length > 0 && !lastIsSpace()) {
        out.push({ ch: " ", start: base + i, end: base + i + 1 });
      }
      i++;
      continue;
    }

    out.push({ ch: SMART_MAP[c] ?? c, start: base + i, end: base + i + 1 });
    i++;
  }

  // Trim a trailing collapsed space.
  while (out.length > 0 && out[out.length - 1]!.ch === " ") out.pop();
  return out;
}

function normalizedString(chars: NormChar[]): string {
  let s = "";
  for (const c of chars) s += c.ch;
  return s;
}

export interface ResolvedSpan {
  char_start: number;
  char_end: number;
}

export class QuoteResolutionError extends Error {}

/**
 * Locates one verbatim `quote` in `canonical` and returns its character span.
 * Throws with an actionable message on no match (showing where the quote first
 * diverges from the text) or on an ambiguous match (quote must be lengthened).
 */
export function resolveQuoteSpan(
  canonical: string,
  quote: string,
  label = "quote",
): ResolvedSpan {
  const canonChars = scan(canonical);
  const canonNorm = normalizedString(canonChars);
  const quoteNorm = normalizedString(scan(quote));

  if (quoteNorm.length === 0) {
    throw new QuoteResolutionError(`${label}: empty after normalization.`);
  }

  const first = canonNorm.indexOf(quoteNorm);
  if (first === -1) {
    throw new QuoteResolutionError(
      `${label}: not found in canonical.\n${describeNearMiss(canonChars, canonNorm, quoteNorm)}`,
    );
  }
  const second = canonNorm.indexOf(quoteNorm, first + 1);
  if (second !== -1) {
    throw new QuoteResolutionError(
      `${label}: found more than once (ambiguous). Lengthen the quote so it is unique.\n` +
        `  first at char ${canonChars[first]!.start}, next at char ${canonChars[second]!.start}.`,
    );
  }

  const startChar = canonChars[first]!;
  const endChar = canonChars[first + quoteNorm.length - 1]!;
  return { char_start: startChar.start, char_end: endChar.end };
}

/** Builds a "quote diverges here" hint: the longest matching prefix + context. */
function describeNearMiss(
  canonChars: NormChar[],
  canonNorm: string,
  quoteNorm: string,
): string {
  let k = quoteNorm.length;
  while (k > 0 && canonNorm.indexOf(quoteNorm.slice(0, k)) === -1) k--;
  if (k === 0) {
    return `  no part of the quote matched — check you copied from corpus/canonical/*.md.`;
  }
  const at = canonNorm.indexOf(quoteNorm.slice(0, k));
  const origStart = canonChars[at]!.start;
  const divergeChar = canonChars[at + k - 1]!.end;
  const matched = quoteNorm.slice(0, k);
  const wantNext = quoteNorm.slice(k, k + 30);
  const gotNext = canonNorm.slice(at + k, at + k + 30);
  return (
    `  matched the first ${k} chars (near canonical offset ${origStart}):\n` +
    `    …${truncateTail(matched, 40)}\n` +
    `  your quote then expects: ${JSON.stringify(wantNext)}\n` +
    `  canonical actually has : ${JSON.stringify(gotNext)}  (around offset ${divergeChar})`
  );
}

function truncateTail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(s.length - n)}`;
}

/** Author-supplied question before span resolution (one YAML list entry). */
export interface AuthoringEntry {
  id: string;
  qtype: string;
  question: string;
  expected_answer: string;
  phase1: boolean;
  gold_quotes: string[];
}

/**
 * Resolves a whole document's authored questions into validated
 * `QuestionRecord`s (PRD §6 schema), or throws the first problem it finds with
 * the offending question id. Pure: canonical text + entries in, records out.
 */
export function buildQuestionRecords(
  docId: string,
  canonical: string,
  entries: AuthoringEntry[],
): QuestionRecord[] {
  const seen = new Set<string>();
  const records: QuestionRecord[] = [];

  for (const e of entries) {
    const where = `[${e.id}]`;
    if (!e.id) throw new QuoteResolutionError(`A question is missing an id.`);
    if (seen.has(e.id)) throw new QuoteResolutionError(`${where} duplicate id.`);
    seen.add(e.id);

    if (!(QTYPES as readonly string[]).includes(e.qtype)) {
      throw new QuoteResolutionError(
        `${where} invalid qtype '${e.qtype}'. Expected one of ${QTYPES.join(", ")}.`,
      );
    }

    const quotes = e.gold_quotes ?? [];
    if (e.qtype === "unanswerable") {
      if (quotes.length > 0) {
        throw new QuoteResolutionError(`${where} unanswerable must have gold_quotes: [].`);
      }
      if (e.expected_answer !== ABSTENTION_TEXT) {
        throw new QuoteResolutionError(
          `${where} unanswerable expected_answer must be exactly ${JSON.stringify(ABSTENTION_TEXT)}.`,
        );
      }
    } else if (quotes.length === 0) {
      throw new QuoteResolutionError(
        `${where} answerable question (${e.qtype}) needs at least one gold_quote.`,
      );
    }

    const spans: ResolvedSpan[] = quotes.map((q, i) =>
      resolveQuoteSpan(canonical, q, `${where} gold_quote #${i + 1}`),
    );
    // Sanity: the resolved slice, normalized, must equal the quote normalized.
    for (let i = 0; i < spans.length; i++) {
      const slice = canonical.slice(spans[i]!.char_start, spans[i]!.char_end);
      if (normalizedString(scan(slice)) !== normalizedString(scan(quotes[i]!))) {
        throw new QuoteResolutionError(
          `${where} gold_quote #${i + 1}: resolved span does not round-trip to the quote.`,
        );
      }
    }
    // Deterministic order; overlapping spans are merged downstream by the metrics.
    spans.sort((a, b) => a.char_start - b.char_start || a.char_end - b.char_end);

    records.push(
      QuestionRecordSchema.parse({
        id: e.id,
        doc_id: docId,
        qtype: e.qtype,
        question: e.question,
        expected_answer: e.expected_answer,
        gold_spans: spans,
        phase1: e.phase1,
      }),
    );
  }

  return records;
}
