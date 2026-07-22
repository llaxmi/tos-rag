import type { Evidence } from "../lib/api";

interface Props {
  index: number;
  evidence: Evidence;
  cited: boolean;
  flashed: boolean;
}

const DOC_LABELS: Record<string, string> = {
  "github-tos": "GitHub ToS",
  "netflix-tou": "Netflix ToU",
};

/**
 * The signature element: a retrieved chunk rendered as an excerpted clause
 * with its character-offset provenance — chunk.text === canonical.slice(start, end).
 */
export function EvidenceCard({ index, evidence, cited, flashed }: Props) {
  const classes = [
    "clause-card",
    cited ? "cited" : "",
    flashed ? "flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={classes} id={`evidence-${index}`}>
      <div className="clause-head">
        <span className="clause-index">{index}</span>
        <span>{DOC_LABELS[evidence.docId] ?? evidence.docId}</span>
        <span className="clause-offsets">
          §{evidence.charStart}–{evidence.charEnd}
        </span>
        <span
          className="clause-score"
          title="Cosine similarity to the question embedding"
        >
          sim {evidence.score.toFixed(2)}
        </span>
      </div>
      <p className="clause-text">{evidence.text}</p>
    </article>
  );
}
