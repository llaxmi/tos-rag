import type React from "react";
import { DOC_LABELS, type Evidence } from "@tos-rag/shared";
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
  /** When present, the whole card becomes a button that focuses this chunk's
   *  span in the source document. */
  onSelect?: () => void;
}

/**
 * A retrieved chunk rendered as an excerpted clause with its character-offset
 * provenance — chunk.text === canonical.slice(charStart, charEnd). The cut mark
 * draws that span literally (docs/design.md §2).
 */
export function EvidenceCard({ index, evidence, cited, flashed, onSelect }: Props) {
  const pct = Math.round(Math.min(1, Math.max(0, evidence.score)) * 100);
  return (
    <Card
      id={`evidence-${index}`}
      {...(onSelect
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: onSelect,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            },
            "aria-label": `Show evidence ${index} in the source document`,
          }
        : {})}
      className={cn(
        "gap-0 rounded-l-none border-l-[3px] px-3.5 py-3 transition-colors",
        cited ? "border-l-compare" : "border-l-rule-strong",
        flashed && "bg-compare-wash",
        onSelect && "hover:bg-accent focus-visible:ring-ring/50 cursor-pointer focus-visible:ring-2 focus-visible:outline-none",
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
