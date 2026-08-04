import { useState, type FormEvent } from "react";
import { RotateCcw } from "lucide-react";
import {
  ask,
  type AskResponse,
  type DocFilter,
  type GeneratorModel,
} from "../lib/api";
import {
  formatMs,
  MODEL_LABELS,
  parseCitations,
  PHASE1_WINNER,
  SIZES,
  STRATEGIES,
} from "@tos-rag/shared";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  EvidenceCard,
  Input,
  Skeleton,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@tos-rag/ui";

const SUGGESTIONS = [
  "How much notice does GitHub give before changing fees?",
  "Can I share my Netflix account outside my household?",
  "Who owns the content I post in a public repository?",
];

/** ToggleGroup needs string values, so "both" stands in for no filter. */
const DOC_OPTIONS: Array<{ label: string; value: string; doc: DocFilter }> = [
  { label: "Both documents", value: "both", doc: undefined },
  { label: "GitHub ToS", value: "github-tos", doc: "github-tos" },
  { label: "Netflix ToU", value: "netflix-tou", doc: "netflix-tou" },
];

const MODELS = (Object.keys(MODEL_LABELS) as GeneratorModel[]).map((value) => ({
  value,
  label: MODEL_LABELS[value],
}));

/** Selected chips read as navy fills, not shadcn's subtle hover surface. */
const CHIP_ON =
  "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

export function AskView() {
  const [question, setQuestion] = useState("");
  const [docValue, setDocValue] = useState("both");
  const [strategy, setStrategy] = useState<string>(PHASE1_WINNER.strategy);
  const [chunkSize, setChunkSize] = useState<number>(PHASE1_WINNER.chunkSize);
  const [model, setModel] = useState<GeneratorModel>("llama");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [flashed, setFlashed] = useState<number | null>(null);

  const isWinner =
    strategy === PHASE1_WINNER.strategy &&
    chunkSize === PHASE1_WINNER.chunkSize &&
    model === "llama";

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    setAskedQuestion(trimmed);
    const docId = DOC_OPTIONS.find((o) => o.value === docValue)?.doc;
    try {
      setResult(await ask(trimmed, docId, { strategy, chunkSize, model }));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(question);
  }

  function flash(id: number) {
    setFlashed(id);
    document.getElementById(`evidence-${id}`)?.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    window.setTimeout(() => setFlashed(null), 1200);
  }

  const parsed = result ? parseCitations(result.answer) : null;

  return (
    <>
      <section className="max-w-[640px]">
        <h1>Ask the Terms of Service.</h1>
        <p className="text-ink-soft mt-4 text-[17px]">
          Plain answers from the GitHub and Netflix agreements — every claim
          cites the exact clause it came from.
        </p>
      </section>

      <Card className="bg-background mt-8 p-2.5">
        <form onSubmit={onSubmit} className="flex gap-2.5">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How much notice before a fee change?"
            aria-label="Your question"
            className="bg-background h-11 flex-1 text-base"
          />
          <Button type="submit" size="lg" disabled={pending} className="px-6">
            {pending && <Spinner aria-hidden="true" role={undefined} />}
            {pending ? "Asking" : "Ask"}
          </Button>
        </form>
      </Card>

      {/* the pipeline settings — a full-width horizontal band under the ask
          box, read left to right: search in X, chunk by Y at size Z, answer
          with W. */}
      <Card
        aria-label="Pipeline configuration"
        className="bg-card mt-4 gap-0 p-5 sm:px-6"
      >
        <div className="border-border mb-5 flex items-center justify-between gap-3 border-b pb-4">
          <span className="text-muted-foreground text-[11px] font-bold uppercase tracking-[0.14em]">
            Pipeline
          </span>
          {isWinner ? (
            <span className="text-ink-soft flex items-center gap-2 font-mono text-[11px]">
              <span
                className="bg-primary size-1.5 rotate-45 rounded-[1px]"
                aria-hidden="true"
              />
              winning config
            </span>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-ink-soft hover:text-foreground h-auto p-0 font-mono text-[11.5px]"
              onClick={() => {
                setStrategy(PHASE1_WINNER.strategy);
                setChunkSize(PHASE1_WINNER.chunkSize);
                setModel("llama");
              }}
            >
              <RotateCcw className="size-3" aria-hidden="true" />
              reset to winner
            </Button>
          )}
        </div>

        {/* one stage per row — label on the left, its options on the right */}
        <div className="flex flex-col gap-5">
          <PipelineStage label="Search in">
            <ToggleGroup
              type="single"
              value={docValue}
              onValueChange={(v) => v && setDocValue(v)}
              aria-label="Limit to a document"
              className="flex flex-wrap gap-1.5"
            >
              {DOC_OPTIONS.map((opt) => (
                <BenchChip key={opt.value} value={opt.value}>
                  {opt.label}
                </BenchChip>
              ))}
            </ToggleGroup>
          </PipelineStage>

          <PipelineStage label="Chunk by" node="cut">
            <ToggleGroup
              type="single"
              value={strategy}
              onValueChange={(v) => v && setStrategy(v)}
              aria-label="Chunking strategy"
              className="flex flex-wrap gap-1.5"
            >
              {STRATEGIES.map((s) => (
                <BenchChip key={s} value={s}>
                  {s}
                </BenchChip>
              ))}
            </ToggleGroup>
          </PipelineStage>

          <PipelineStage label="At size">
            <ToggleGroup
              type="single"
              value={String(chunkSize)}
              onValueChange={(v) => v && setChunkSize(Number(v))}
              aria-label="Chunk size in tokens"
              className="flex flex-wrap gap-1.5"
            >
              {SIZES.map((s) => (
                <BenchChip key={s} value={String(s)}>
                  {s} tok
                </BenchChip>
              ))}
            </ToggleGroup>
          </PipelineStage>

          <PipelineStage label="Answer with">
            <ToggleGroup
              type="single"
              value={model}
              onValueChange={(v) => v && setModel(v as GeneratorModel)}
              aria-label="Generator model"
              className="flex flex-wrap gap-1.5"
            >
              {MODELS.map((m) => (
                <BenchChip key={m.value} value={m.value}>
                  {m.label}
                </BenchChip>
              ))}
            </ToggleGroup>
          </PipelineStage>
        </div>
      </Card>

      {!pending && (
        <div className="mt-8 flex flex-wrap items-baseline gap-2">
          <span className="text-muted-foreground text-[11px] font-bold uppercase tracking-[0.12em]">
            {result ? "ask another" : "try"}
          </span>
          {SUGGESTIONS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              className="text-ink-soft h-auto rounded-full px-3.5 py-1.5 text-[13.5px] font-normal shadow-none"
              onClick={() => {
                setQuestion(s);
                void submit(s);
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {(pending || error || result) && (
        <section aria-label="Answer" className="mt-8 min-h-45">
          {pending && (
            <div role="status" aria-label="Retrieving clauses and generating">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="mt-4 h-4 w-full" />
              <Skeleton className="mt-2 h-4 w-11/12" />
              <Skeleton className="mt-2 h-4 w-4/5" />
            </div>
          )}

          {/* The live region is mounted before the error exists, so screen
              readers announce the failure when it swaps in; a role="alert"
              inserted into the DOM is not reliably announced. Alert's own
              role is dropped so the region is the only announcer. */}
          <div role="alert">
            {error && (
              <Alert variant="destructive" role={undefined}>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>

          {!pending && !error && result && parsed && (
            <div>
              {/* scannable status line — model, config and cost read at a
                  glance before the prose. */}
              <div className="border-border text-ink-soft mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b pb-3 font-mono text-[12.5px]">
                <span className="text-muted-foreground font-bold uppercase tracking-[0.14em]">
                  Answer
                </span>
                <span className="text-rule-strong" aria-hidden="true">
                  ·
                </span>
                <span className="text-foreground">
                  {MODEL_LABELS[result.model] ?? result.model}
                </span>
                <span className="text-rule-strong" aria-hidden="true">
                  ·
                </span>
                <span>
                  {result.config.strategy} × {result.config.chunkSize}
                </span>
                <span className="text-rule-strong" aria-hidden="true">
                  ·
                </span>
                <span>
                  {formatMs(
                    result.timings.retrievalMs + result.timings.generationMs,
                  )}
                </span>
                <span className="text-rule-strong" aria-hidden="true">
                  ·
                </span>
                <span>{result.evidence.length} clauses</span>
              </div>

              <p className="text-ink-soft mb-4 text-[16px] font-medium leading-snug">
                <span className="text-muted-foreground mr-2.5 font-mono text-[13px]">
                  Q
                </span>
                {askedQuestion}
              </p>

              {result.abstained ? (
                <div className="border-rule-strong bg-card text-ink-soft max-w-[68ch] rounded-lg border border-dashed p-4.5">
                  <Badge
                    variant="outline"
                    className="border-destructive text-destructive mb-2.5 mr-2.5 font-mono text-[11px] uppercase tracking-[0.14em]"
                  >
                    No answer in corpus
                  </Badge>
                  The corpus doesn't answer this, so the model declined rather
                  than guess. Its reply, verbatim:{" "}
                  <span className="text-foreground font-mono text-sm">
                    {result.answer}
                  </span>
                </div>
              ) : (
                <p className="text-foreground max-w-[68ch] text-[18.5px] leading-[1.75]">
                  <span className="text-muted-foreground mr-2.5 font-mono text-[16px]">
                    A
                  </span>
                  {parsed.segments.map((seg, i) =>
                    seg.kind === "text" ? (
                      <span key={i}>{seg.value}</span>
                    ) : (
                      <button
                        key={i}
                        type="button"
                        onClick={() => flash(seg.value)}
                        aria-label={`Show evidence ${seg.value}`}
                        className="bg-compare-wash text-compare border-compare hover:bg-compare hover:text-background focus-visible:ring-ring/50 mx-0.5 inline-block rounded-[3px] border px-[5px] py-0.5 align-super font-mono text-[11px] leading-none transition-colors focus-visible:ring-[3px]"
                      >
                        {seg.value}
                      </button>
                    ),
                  )}
                </p>
              )}

              <div className="text-muted-foreground mt-5 flex flex-wrap font-mono text-[12px] [&>span+span]:before:text-rule-strong [&>span+span]:before:mx-2.5 [&>span+span]:before:content-['·']">
                <span>retrieval {formatMs(result.timings.retrievalMs)}</span>
                <span>
                  generation {formatMs(result.timings.generationMs)}
                </span>
                <span>
                  {result.tokens.input} in · {result.tokens.output} out tokens
                </span>
              </div>

              {result.evidence.length > 0 && (
                <div className="mt-10">
                  <h2 className="text-ink-soft mb-4 flex items-baseline gap-2.5 text-[11.5px] font-bold uppercase tracking-[0.12em]">
                    Retrieved
                    <span className="text-muted-foreground font-mono text-[11.5px] font-normal normal-case tracking-normal">
                      k = {result.evidence.length}
                    </span>
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {result.evidence.map((ev, i) => (
                      <EvidenceCard
                        key={`${ev.docId}-${ev.charStart}`}
                        index={i + 1}
                        evidence={ev}
                        cited={parsed?.citedIds.includes(i + 1) ?? false}
                        flashed={flashed === i + 1}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * One stage of the pipeline as a row: a marker and verb-phrase label on the
 * left, the stage's chips on the right. The "cut" marker places the app's
 * cut-mark signature on the chunking stage — where the pipeline actually cuts
 * the document.
 */
function PipelineStage({
  label,
  node = "station",
  children,
}: {
  label: string;
  node?: "station" | "cut";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-center gap-2.5 sm:w-36 sm:shrink-0">
        <span
          className="flex w-3.5 shrink-0 justify-center"
          aria-hidden="true"
        >
          {node === "cut" ? (
            <span className="cut-mark-rule block w-3.5" />
          ) : (
            <span className="bg-primary size-2 rotate-45 rounded-[1px]" />
          )}
        </span>
        <span className="text-ink-soft text-[11px] font-bold uppercase tracking-[0.14em]">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function BenchChip({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <ToggleGroupItem
      value={value}
      className={cn(
        "border-border bg-background text-ink-soft hover:bg-accent hover:text-foreground h-auto rounded-md border px-3 py-1.5 font-mono text-[13px] transition-colors",
        CHIP_ON,
      )}
    >
      {children}
    </ToggleGroupItem>
  );
}
