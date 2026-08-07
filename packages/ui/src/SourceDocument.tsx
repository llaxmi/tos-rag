import type { DocSegment } from "@tos-rag/shared";
import { cn } from "./lib/utils";

/** Tailwind can only see class names it finds as literal strings, so the five
 *  citation tints are written out rather than built by interpolation. */
const CITE_FILL = [
  "bg-cite-1 shadow-[inset_0_-2px_0_var(--cite-1-rule)]",
  "bg-cite-2 shadow-[inset_0_-2px_0_var(--cite-2-rule)]",
  "bg-cite-3 shadow-[inset_0_-2px_0_var(--cite-3-rule)]",
  "bg-cite-4 shadow-[inset_0_-2px_0_var(--cite-4-rule)]",
  "bg-cite-5 shadow-[inset_0_-2px_0_var(--cite-5-rule)]",
];

const CITE_BADGE = [
  "bg-cite-1-rule",
  "bg-cite-2-rule",
  "bg-cite-3-rule",
  "bg-cite-4-rule",
  "bg-cite-5-rule",
];

function tint(index: number, table: string[]): string {
  return table[(index - 1) % table.length]!;
}

/**
 * The frozen canonical document with its cited spans painted in place.
 *
 * The segments come from `buildSpanSegments`, which guarantees they reassemble
 * the document verbatim — so what is rendered here is the document, not a
 * reconstruction of it. Whitespace is preserved (`whitespace-pre-wrap`) for the
 * same reason: the offsets index the exact string, newlines included.
 */
export function SourceDocument({
  segments,
  activeIndex,
  className,
}: {
  segments: DocSegment[];
  activeIndex: number | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-ink-soft max-h-[32rem] max-w-[68ch] overflow-y-auto whitespace-pre-wrap text-[14.5px] leading-[1.8]",
        className,
      )}
    >
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <mark
            key={i}
            id={`doc-span-${seg.index}`}
            className={cn(
              "text-foreground rounded-[2px] px-0.5 py-px transition-shadow",
              tint(seg.index, CITE_FILL),
              activeIndex === seg.index && "ring-ring/60 ring-2",
            )}
          >
            {seg.text}
            <span
              className={cn(
                "text-background ml-1 inline-block rounded-[2px] px-1 align-super font-mono text-[10px] leading-tight",
                tint(seg.index, CITE_BADGE),
              )}
            >
              {seg.index}
            </span>
          </mark>
        ),
      )}
    </div>
  );
}
