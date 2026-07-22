import type { RetrievedChunk } from "./types";

/** The exact abstention reply required by the fixed prompt (PRD §10.6). */
export const ABSTENTION_TEXT = "I don't know";

/** True iff the answer is exactly the abstention phrase (CRAG "Missing"). */
export function isAbstention(answer: string): boolean {
  return (
    answer.replace(/[’‘]/g, "'").trim().toLowerCase() ===
    ABSTENTION_TEXT.toLowerCase()
  );
}

/**
 * The single fixed generation prompt used by both models in both phases
 * (PRD §10.6). Any change to this template invalidates cross-run comparisons.
 */
export function buildRagPrompt(
  question: string,
  chunks: readonly RetrievedChunk[],
): string {
  const context = chunks
    .map(
      (c, i) =>
        `[${i + 1}] [${c.docId} §${c.charStart}–${c.charEnd}]\n${c.text}`,
    )
    .join("\n\n");
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
