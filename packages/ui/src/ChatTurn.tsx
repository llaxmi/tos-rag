import {
  formatMs,
  MODEL_LABELS,
  parseCitations,
  type AskResponse,
} from "@tos-rag/shared";
import { Alert, AlertDescription } from "./primitives/alert";
import { Badge } from "./primitives/badge";
import { Skeleton } from "./primitives/skeleton";
import { cn } from "./lib/utils";

interface Props {
  question: string;
  status: "pending" | "done" | "error";
  response?: AskResponse;
  error?: string;
  /** Whether the evidence rail is currently showing this turn. */
  active: boolean;
  onCiteClick: (index: number) => void;
}

/**
 * One question and its answer. A failed turn stays in the thread rather than
 * vanishing — the question was still asked, and losing it would erase the
 * user's own words on a backend hiccup.
 */
export function ChatTurn({
  question,
  status,
  response,
  error,
  active,
  onCiteClick,
}: Props) {
  const parsed = response ? parseCitations(response.answer) : null;

  return (
    <article
      className={cn(
        "flex flex-col gap-6 border-l-2 pl-5 transition-colors",
        active ? "border-l-primary" : "border-l-transparent",
      )}
    >
      <div className="flex flex-col items-end gap-1.5 self-end">
        <span className="text-muted-foreground font-mono text-[11px]">You</span>
        <p className="border-border bg-card max-w-[52ch] rounded-md border px-4 py-3 text-[15px] leading-relaxed">
          {question}
        </p>
      </div>

      {status === "pending" && (
        <div role="status" aria-label="Retrieving clauses and generating">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-11/12" />
          <Skeleton className="mt-2 h-4 w-4/5" />
        </div>
      )}

      {/* Mounted before the error exists so screen readers announce the swap;
          a role="alert" inserted into the DOM is not reliably announced. */}
      <div role="alert">
        {status === "error" && error && (
          <Alert variant="destructive" role={undefined}>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      {status === "done" && response && parsed && (
        <div className="flex flex-col gap-3">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 font-mono text-[11.5px]">
            <span>{MODEL_LABELS[response.model] ?? response.model}</span>
            <span aria-hidden="true">·</span>
            <span>
              {response.config.strategy} × {response.config.chunkSize}
            </span>
            <span aria-hidden="true">·</span>
            <span>{response.evidence.length} chunks</span>
            <span aria-hidden="true">·</span>
            <span>
              {formatMs(
                response.timings.retrievalMs + response.timings.generationMs,
              )}
            </span>
          </div>

          {response.abstained ? (
            <div className="border-rule-strong bg-card text-ink-soft max-w-[68ch] rounded-lg border border-dashed p-4.5">
              <Badge
                variant="outline"
                className="border-destructive text-destructive mb-2.5 mr-2.5 font-mono text-[11px] uppercase tracking-[0.14em]"
              >
                No answer in corpus
              </Badge>
              The corpus doesn't answer this, so the model declined rather than
              guess. Its reply, verbatim:{" "}
              <span className="text-foreground font-mono text-sm">
                {response.answer}
              </span>
            </div>
          ) : (
            <p className="text-foreground max-w-[68ch] text-[17px] leading-[1.75]">
              {parsed.segments.map((seg, i) =>
                seg.kind === "text" ? (
                  <span key={i}>{seg.value}</span>
                ) : (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onCiteClick(seg.value)}
                    aria-label={`Show evidence ${seg.value}`}
                    className="bg-compare-wash text-compare border-compare hover:bg-compare hover:text-background focus-visible:ring-ring/50 mx-0.5 inline-block rounded-[3px] border px-[5px] py-0.5 align-super font-mono text-[11px] leading-none transition-colors focus-visible:ring-[3px]"
                  >
                    {seg.value}
                  </button>
                ),
              )}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
