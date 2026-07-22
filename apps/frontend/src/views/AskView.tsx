import { useState, type FormEvent } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
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
  SIZES,
  STRATEGIES,
} from "@tos-rag/shared";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EvidenceCard,
  Input,
  Separator,
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

/** The experiment's winning configuration — the bench's default state. */
const WINNER = { strategy: "sentence", chunkSize: 256 as number };

/** Selected chips read as navy fills, not shadcn's subtle hover surface. */
const CHIP_ON =
  "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

export function AskView() {
  const [question, setQuestion] = useState("");
  const [docValue, setDocValue] = useState("both");
  const [strategy, setStrategy] = useState<string>(WINNER.strategy);
  const [chunkSize, setChunkSize] = useState<number>(WINNER.chunkSize);
  const [model, setModel] = useState<GeneratorModel>("llama");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [flashed, setFlashed] = useState<number | null>(null);

  const isWinner =
    strategy === WINNER.strategy &&
    chunkSize === WINNER.chunkSize &&
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

      <Card className="my-8 gap-4 p-4">
        <form onSubmit={onSubmit} className="contents">
          <div className="flex gap-3">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. How much notice before a fee change?"
              aria-label="Your question"
              className="bg-background h-10 flex-1 text-base"
            />
            <Button type="submit" size="lg" disabled={pending}>
              {pending && <Spinner aria-hidden="true" role={undefined} />}
              {pending ? "Asking" : "Ask"}
            </Button>
          </div>

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <ToggleGroup
              type="single"
              value={docValue}
              onValueChange={(v) => v && setDocValue(v)}
              aria-label="Limit to a document"
              className="flex-wrap gap-1.5"
            >
              {DOC_OPTIONS.map((opt) => (
                <ToggleGroupItem
                  key={opt.value}
                  value={opt.value}
                  className={cn(
                    "border-border h-auto rounded-full border px-3.5 py-1.5 text-[13px]",
                    CHIP_ON,
                  )}
                >
                  {opt.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {/* the three experimental variables, collapsed to one line */}
            <Collapsible className="min-w-60 flex-1">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground ml-auto flex font-mono text-xs font-normal"
                >
                  pipeline
                  <span className="text-ink-soft">
                    {strategy} × {chunkSize} · {MODEL_LABELS[model]}
                  </span>
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 flex flex-col gap-2">
                <BenchRow label="strategy">
                  <ToggleGroup
                    type="single"
                    value={strategy}
                    onValueChange={(v) => v && setStrategy(v)}
                    aria-label="Chunking strategy"
                    className="flex-wrap gap-1.5"
                  >
                    {STRATEGIES.map((s) => (
                      <BenchChip key={s} value={s}>
                        {s}
                      </BenchChip>
                    ))}
                  </ToggleGroup>
                </BenchRow>

                <BenchRow label="size">
                  <ToggleGroup
                    type="single"
                    value={String(chunkSize)}
                    onValueChange={(v) => v && setChunkSize(Number(v))}
                    aria-label="Chunk size in tokens"
                    className="flex-wrap gap-1.5"
                  >
                    {SIZES.map((s) => (
                      <BenchChip key={s} value={String(s)}>
                        {s} tok
                      </BenchChip>
                    ))}
                  </ToggleGroup>
                </BenchRow>

                <BenchRow label="generator">
                  <ToggleGroup
                    type="single"
                    value={model}
                    onValueChange={(v) => v && setModel(v as GeneratorModel)}
                    aria-label="Generator model"
                    className="flex-wrap gap-1.5"
                  >
                    {MODELS.map((m) => (
                      <BenchChip key={m.value} value={m.value}>
                        {m.label}
                      </BenchChip>
                    ))}
                  </ToggleGroup>
                  {!isWinner && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="text-ink-soft h-auto p-0 font-mono text-[11.5px]"
                      onClick={() => {
                        setStrategy(WINNER.strategy);
                        setChunkSize(WINNER.chunkSize);
                        setModel("llama");
                      }}
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                      reset to winning config
                    </Button>
                  )}
                </BenchRow>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </form>
      </Card>

      {!pending && (
        <div className="mb-8 flex flex-wrap items-baseline gap-2">
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
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-label="Answer" className="min-h-45">
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
                <p className="text-ink-soft mb-4 text-[17px] font-semibold">
                  <span className="text-muted-foreground mr-2.5 font-mono">
                    Q.
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
                  <p className="max-w-[68ch] text-[18px] leading-[1.7]">
                    <span className="text-muted-foreground mr-2.5 font-mono text-[17px]">
                      A.
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

                <div className="text-muted-foreground mt-4.5 flex flex-wrap font-mono text-xs [&>span+span]:before:text-rule-strong [&>span+span]:before:mx-2.5 [&>span+span]:before:content-['·']">
                  <span>
                    config {result.config.strategy} × {result.config.chunkSize}
                  </span>
                  <span>{MODEL_LABELS[result.model] ?? result.model}</span>
                  <span>retrieval {formatMs(result.timings.retrievalMs)}</span>
                  <span>
                    generation {formatMs(result.timings.generationMs)}
                  </span>
                  <span>
                    {result.tokens.input} in · {result.tokens.output} out tokens
                  </span>
                </div>
              </div>
            )}
          </section>

          <aside aria-label="Evidence">
            <h2 className="text-ink-soft mb-4 flex items-baseline justify-between gap-3 text-[11.5px] font-bold uppercase tracking-[0.12em]">
              Retrieved
              {result && result.evidence.length > 0 && (
                <span className="text-muted-foreground font-mono text-[11.5px] font-normal normal-case tracking-normal">
                  k = {result.evidence.length}
                </span>
              )}
            </h2>
            {result && result.evidence.length > 0 ? (
              <div className="flex flex-col gap-3">
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
            ) : (
              <p className="border-border text-muted-foreground border-l-2 py-1 pl-3.5 text-sm">
                Ask a question to see the chunks it retrieved, each with the
                character span it was cut from.
              </p>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

function BenchRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground w-21 shrink-0 text-[11px] font-bold uppercase tracking-[0.12em]">
        {label}
      </span>
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
        "border-border h-auto rounded border px-2.5 py-1 font-mono text-xs",
        CHIP_ON,
      )}
    >
      {children}
    </ToggleGroupItem>
  );
}
