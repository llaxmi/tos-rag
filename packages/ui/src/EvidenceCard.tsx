import type { Evidence } from "@tos-rag/shared";
import { CutMark } from "./CutMark";
import { Badge } from "./primitives/badge";
import { Card } from "./primitives/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/tooltip";
import { cn } from "./lib/utils";

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
 * A retrieved chunk rendered as an excerpted clause with its character-offset
 * provenance — chunk.text === canonical.slice(charStart, charEnd). The cut mark
 * draws that span literally (docs/design.md §2).
 */
export function EvidenceCard({ index, evidence, cited, flashed }: Props) {
  const pct = Math.round(Math.min(1, Math.max(0, evidence.score)) * 100);
  return (
    <Card
      id={`evidence-${index}`}
      className={cn(
        "gap-0 rounded-l-none border-l-[3px] px-3.5 py-3 transition-colors",
        cited ? "border-l-compare" : "border-l-rule-strong",
        flashed && "bg-compare-wash",
      )}
    >
      <div className="text-muted-foreground flex flex-wrap items-baseline gap-2.5 font-mono text-[11.5px]">
        <Badge variant="outline" className="text-foreground font-normal">
          {index}
        </Badge>
        <span>{DOC_LABELS[evidence.docId] ?? evidence.docId}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-ink-soft ml-auto inline-flex cursor-default items-center gap-2">
              <span
                className="bg-border h-1.5 w-14 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <span
                  className="bg-seq-4 block h-full"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="text-foreground tabular-nums">{pct}%</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Cosine similarity to the question embedding
          </TooltipContent>
        </Tooltip>
      </div>
      <CutMark
        start={evidence.charStart}
        end={evidence.charEnd}
        className="mt-2.5"
      />
      {/* verbatim source text — mono says "these words are the document's" */}
      <p className="text-ink-soft mt-3 font-mono text-[13.5px] leading-[1.6]">
        {evidence.text}
      </p>
    </Card>
  );
}
