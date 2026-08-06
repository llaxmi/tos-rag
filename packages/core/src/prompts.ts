import type { RetrievedChunk } from "./types";

/** The exact abstention reply required by the fixed prompt (PRD §10.6). */
export const ABSTENTION_TEXT = "I don't know";

/**
 * True iff the answer is the abstention phrase, ignoring case, surrounding
 * whitespace, smart quotes, and trailing sentence punctuation.
 *
 * Trailing punctuation must be ignored here because `normalizeAnswer` (SQuAD)
 * strips it too: when the two disagreed, "I don't know." and "I don't know"
 * took different branches of the CRAG decision order and scored a full point
 * apart — see the 2026-08-01 entry in `docs/report-notes.md`.
 */
export function isAbstention(answer: string): boolean {
  return (
    answer
      .replace(/[’‘]/g, "'")
      .trim()
      .replace(/[.!?]+$/, "")
      .trim()
      .toLowerCase() === ABSTENTION_TEXT.toLowerCase()
  );
}

/**
 * The context block of the fixed prompt: a numbered `[doc §start–end]` header
 * per chunk, blank-line separated.
 *
 * Shared with `reconstructContext` (`eval/faithfulness.ts`), which rebuilds this
 * block from stored spans. Faithfulness only means something if it scores
 * against exactly what the generator saw, so both go through one template
 * instead of two copies that have to keep agreeing.
 */
export function formatContextBlocks(
  chunks: readonly Pick<RetrievedChunk, "docId" | "charStart" | "charEnd" | "text">[],
): string {
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] [${c.docId} §${c.charStart}–${c.charEnd}]\n${c.text}`,
    )
    .join("\n\n");
}

/**
 * The single fixed generation prompt used by both models in both phases
 * (PRD §10.6). Any change to this template invalidates cross-run comparisons.
 */
export function buildRagPrompt(
  question: string,
  chunks: readonly RetrievedChunk[],
): string {
  const context = formatContextBlocks(chunks);
  return [
    "You answer questions about Terms of Service documents using ONLY the provided context.",
    "",
    "Context:",
    context,
    "",
    `Question: ${question}`,
    "",
    "Rules:",
    "- Answer concisely using only information from the context.",
    `- If the answer is not in the context, reply exactly: ${ABSTENTION_TEXT}`,
  ].join("\n");
}
