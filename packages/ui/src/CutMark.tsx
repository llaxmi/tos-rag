import { cn } from "./lib/utils";

interface Props {
  /** Character offsets to label the mark with. Omit for a plain divider. */
  start?: number;
  end?: number;
  className?: string;
}

/**
 * The system's signature element (docs/design.md §2): a hairline terminated by
 * perpendicular ticks — a cut through a document. Labelled with real character
 * offsets where a boundary is known, unlabelled as a section divider.
 *
 * It only ever marks a boundary. If it appears anywhere else, remove it.
 *
 * Deliberately not a shadcn `Separator`: this carries data (the span it marks)
 * and needs the end ticks, which no primitive provides.
 */
export function CutMark({ start, end, className }: Props) {
  const labelled = start !== undefined && end !== undefined;
  return (
    <div
      className={cn("block w-full", className)}
      aria-hidden={labelled ? undefined : "true"}
    >
      <span className="cut-mark-rule" />
      {labelled && (
        <span className="text-muted-foreground mt-1.5 flex justify-between font-mono text-[11.5px]">
          <span>{start}</span>
          <span>{end}</span>
        </span>
      )}
    </div>
  );
}
