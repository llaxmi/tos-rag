import type { RetrievedRef } from "../orchestrator/runOne";
import { formatContextBlocks, isAbstention } from "../prompts";
import type { Judge } from "./evaluate";

/**
 * Faithfulness (PRD §10.2): how much of an answer the retrieved context actually
 * supports. Two judge calls per answer — split into claims, then check them all
 * at once. The prompts and parsing here are pure and the model call goes through
 * the injected `Judge`, so the module tests with a fake judge and no network.
 *
 * This measures grounding, not correctness: an answer can be perfectly faithful
 * to the context and still wrong. That is why it is reported next to CRAG, not
 * instead of it.
 */

export interface FaithfulnessInput {
  /** Used only to make a terse answer self-contained; never scored itself. */
  question: string;
  answer: string;
  /** The retrieved context, rebuilt by `reconstructContext`. */
  context: string;
}

/**
 * A score, or null with the reason. The two reasons are different findings — an
 * abstention is the model behaving correctly, zero statements is an answer with
 * nothing to check — so the caller reports them separately.
 */
export type FaithfulnessResult =
  | { score: number; supported: number; total: number }
  | { score: null; reason: "abstention" | "no-statements" };

/**
 * The question comes first, matching `buildCragPrompt`. It only tells the model
 * what a pronoun or missing subject in the answer refers to — the prompt forbids
 * answering the question, correcting the answer, or importing claims the answer
 * does not make.
 *
 * Without it, a short correct answer like "90 days." has no subject to attach
 * to, so this step returns a fragment the context cannot support and a grounded
 * answer scores 0.000. That happened for real: on the collected Phase-2 rows
 * (issue #25) faithfulness ran opposite to CRAG because short answers were
 * penalized. RAGAS passes the question here for the same reason.
 */
export function buildDecomposePrompt(question: string, answer: string): string {
  return [
    "Decompose the answer below into atomic factual statements.",
    "",
    "The question is given only as context for decontextualizing the answer —",
    "use it to resolve pronouns and to recover an implicit subject the answer",
    "relies on. The statements you extract must come from the answer alone: do",
    "not answer the question, do not correct the answer, and do not import any",
    "claim that the question makes but the answer does not.",
    "",
    "Rules:",
    "- One simple, verifiable claim per statement.",
    "- Each statement must be self-contained: no pronouns, no references to",
    "  other statements. Repeat the subject in full instead.",
    "- Do not add, infer, or correct anything. Only restate what the answer says.",
    "- If the answer makes no factual claim, return an empty list.",
    "",
    'Respond with ONLY a JSON object: {"statements": ["...", "..."]}',
    "",
    "Example",
    "Question: What is the minimum age to use GitHub?",
    "Answer: 13 years old.",
    '{"statements": ["You must be at least 13 years old to use GitHub."]}',
    "",
    "Now decompose this one.",
    `Question: ${question}`,
    `Answer: ${answer}`,
  ].join("\n");
}

/** JSON first, then a numbered-line fallback (PRD §10.2 robustness). */
export function parseStatements(text: string): string[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { statements?: unknown };
      if (Array.isArray(obj.statements)) {
        return obj.statements.map((s) => String(s).trim()).filter((s) => s.length > 0);
      }
    } catch {
      // fall through to the line fallback
    }
  }
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

export function buildNliPrompt(
  context: string,
  statements: readonly string[],
): string {
  return [
    "Decide whether each statement is supported by the context below.",
    "",
    'A statement is "supported" only if the context states or directly entails it.',
    'If the context is silent on it, or contradicts it, answer "unsupported".',
    "Judge support by the context alone — not by whether the statement is true.",
    "",
    `Return exactly ${statements.length} verdict(s), in order, as ONLY a JSON`,
    'object: {"verdicts": ["supported" | "unsupported", ...]}',
    "",
    "Context:",
    context,
    "",
    "Statements:",
    ...statements.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
}

/**
 * Parses verdicts in order. JSON first, then a word scan: `\bsupported\b` does
 * not match inside "unsupported", the same trick `parseCragVerdict` uses.
 * Throws rather than defaulting — a default would bias the score one way.
 */
export function parseNliVerdicts(text: string): boolean[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { verdicts?: unknown };
      if (Array.isArray(obj.verdicts) && obj.verdicts.length > 0) {
        const normalized = obj.verdicts.map((v) => String(v).trim().toLowerCase());
        // Every token must be exactly "supported" or "unsupported". Something
        // like "yes" is not a verdict, and `=== "supported"` would score it
        // false — a clean-looking 0.000 for an answer that may be fully
        // grounded. Falling through instead of throwing still lets the word scan
        // rescue a reply that has bad JSON but readable verdicts elsewhere.
        if (normalized.every((v) => v === "supported" || v === "unsupported")) {
          return normalized.map((v) => v === "supported");
        }
      }
    } catch {
      // fall through to the word scan
    }
  }
  const words = text.toLowerCase().match(/\b(?:un)?supported\b/g);
  if (!words) {
    throw new Error(
      `Could not read any verdict from judge output: ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
  return words.map((w) => w === "supported");
}

/**
 * Rebuilds the text the model saw. `runs.retrieved` stores spans, not text, so
 * each one is sliced back out of the canonical document — exact by the chunker
 * offset invariant (`chunk.text === canonical.slice(charStart, charEnd)`). The
 * blocks go through `formatContextBlocks`, the same layout `buildRagPrompt`
 * uses, so this cannot drift from the frozen prompt.
 *
 * Offsets are UTF-16 code units, matching `String#slice` — not Postgres
 * `length()`, which counts codepoints and will disagree.
 *
 * The caller is responsible for proving the canonical still matches what was
 * ingested before slicing it.
 */
export function reconstructContext(
  retrieved: readonly RetrievedRef[],
  canonicals: ReadonlyMap<string, string>,
): string {
  return formatContextBlocks(
    retrieved.map((r) => {
      const doc = canonicals.get(r.doc_id);
      if (doc === undefined) {
        throw new Error(
          `No canonical text loaded for '${r.doc_id}' — cannot reconstruct the retrieved context.`,
        );
      }
      if (r.char_end > doc.length || r.char_start < 0 || r.char_start > r.char_end) {
        throw new Error(
          `Span ${r.char_start}–${r.char_end} is out of range for '${r.doc_id}' ` +
            `(length ${doc.length}). The canonical text has drifted from the run.`,
        );
      }
      return {
        docId: r.doc_id,
        charStart: r.char_start,
        charEnd: r.char_end,
        text: doc.slice(r.char_start, r.char_end),
      };
    }),
  );
}

export async function scoreFaithfulness(
  input: FaithfulnessInput,
  deps: { judge: Judge },
): Promise<FaithfulnessResult> {
  // An abstention has no claims to ground. Checked before any call, so it costs
  // nothing.
  if (isAbstention(input.answer)) return { score: null, reason: "abstention" };

  const statements = parseStatements(
    await deps.judge.complete(buildDecomposePrompt(input.question, input.answer)),
  );
  // 0/0 is undefined and 1.0 would score an empty answer perfectly faithful.
  if (statements.length === 0) return { score: null, reason: "no-statements" };

  const prompt = buildNliPrompt(input.context, statements);
  let verdicts = parseNliVerdicts(await deps.judge.complete(prompt));
  if (verdicts.length !== statements.length) {
    // One retry (PRD §10.2). After that the row stays NULL and the next run
    // picks it up.
    verdicts = parseNliVerdicts(await deps.judge.complete(prompt));
  }
  if (verdicts.length !== statements.length) {
    throw new Error(
      `Judge returned ${verdicts.length} verdicts for ${statements.length} statements after one retry.`,
    );
  }

  const supported = verdicts.filter(Boolean).length;
  return { score: supported / statements.length, supported, total: statements.length };
}
