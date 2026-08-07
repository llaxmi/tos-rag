import { useEffect, useState } from "react";
import { getResults } from "../lib/api";
import {
  formatMeanCI,
  formatUSD,
  NO_TEST_METHOD,
  parseAnalysis,
  PHASE1_WINNER,
  wilcoxonMethodPhrase,
  type ConfigMetrics,
  type DashboardData,
  type FactorLevel,
  type BestVsRest,
  type MetricValue,
  type PairedTable,
} from "@tos-rag/shared";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  ContactSheet,
  CutMark,
  FactorBars,
  GENERATION_COLOR,
  Heatmap,
  HeatmapScale,
  LatencyBoxes,
  LatencyStacks,
  RETRIEVAL_COLOR,
  Swatch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  type FactorBar,
} from "@tos-rag/ui";

const METRIC_COLUMNS: Array<{ key: keyof ConfigMetrics; label: string }> = [
  { key: "truthfulness", label: "Truthfulness" },
  { key: "faithfulness", label: "Faithfulness" },
  { key: "charRecall", label: "Char R@5" },
  { key: "charPrecision", label: "Char P@5" },
  { key: "hitRate", label: "Hit@5" },
  { key: "squadF1", label: "SQuAD F1" },
];

/** The dashboard is a sequence — Phase 1, then Phase 2, then operational. */
const SECTIONS = [
  { id: "sec-1", n: "§1", label: "All configurations" },
  { id: "sec-2", n: "§2", label: "Strategy × size" },
  { id: "sec-3", n: "§3", label: "Each factor" },
  { id: "sec-4", n: "§4", label: "Generators" },
  { id: "sec-5", n: "§5", label: "Latency" },
  { id: "sec-6", n: "§6", label: "Cost" },
];

const EYEBROW =
  "text-ink-soft mb-2.5 text-[11.5px] font-bold uppercase tracking-[0.12em]";
const NUM_CELL = "text-ink-soft text-right font-mono text-[12.5px]";
const HEAD_CELL =
  "text-muted-foreground text-right font-mono text-[11px] uppercase tracking-[0.06em]";

/** §4 only — larger type than the other tables, per feedback on that section. */
const NUM_CELL_LG = "text-ink-soft text-right font-mono text-[14.5px]";
const HEAD_CELL_LG =
  "text-muted-foreground text-right font-mono text-[12px] uppercase tracking-[0.06em]";

/** Stacked mean + CI range, used in the §4 comparison table cells. */
function MeanCI({ value, strong }: { value: MetricValue | null; strong?: boolean }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="leading-tight">
      <div className={cn(strong && "text-foreground font-medium")}>
        {value.mean.toFixed(2)}
      </div>
      <div className="text-muted-foreground text-[12px]">
        {value.ci
          ? `${value.ci[0].toFixed(2)}–${value.ci[1].toFixed(2)}`
          : (value.ciOmittedReason ?? "no CI")}
      </div>
    </div>
  );
}

/** " (holm-corrected, α = 0.05)" — but only for the parts the payload carried.
 *  A missing correction or threshold drops its fragment rather than being
 *  filled in from the experiment's constants, which the payload did not state. */
function testQualifier({ correction, alpha }: BestVsRest): string {
  const parts = [
    correction ? `${correction}-corrected` : null,
    alpha !== null ? `α = ${alpha}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Shown in place of a figure whose payload has not been computed. The
 *  dashboard states the absence rather than filling it with a plausible
 *  number — the same rule the report follows for unmeasured values.
 *
 *  `failed` distinguishes "the analysis has not been run" from "we could not
 *  ask": telling a reader to run `pnpm analyze` when the backend is simply
 *  unreachable is a wrong diagnosis, not a missing one. */
function NoData({ what, failed }: { what: string; failed?: boolean }) {
  return (
    <Card className="border-dashed p-8">
      <p className="text-muted-foreground text-[13.5px]">
        {failed ? (
          <>Couldn't load {what} — the results service is unavailable.</>
        ) : (
          <>
            No {what} in the database yet. Run{" "}
            <code className="font-mono">pnpm analyze</code> to compute it.
          </>
        )}
      </p>
    </Card>
  );
}

export function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0]!.id);

  useEffect(() => {
    getResults()
      .then((rows) => setData(parseAnalysis(rows ?? [])))
      .catch(() => setLoadFailed(true));
  }, []);

  // Scrollspy: track which section's heading has scrolled past the
  // "reading line" near the top of the viewport. Walking the sections in
  // document order and taking the last one whose top has crossed that
  // line is deterministic — there's no gap where nothing matches, which
  // is what caused the highlight to get stuck on a previous section when
  // scrolling past a short one.
  useEffect(() => {
    const elements = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (elements.length === 0) return;

    const READING_LINE = 110; // px from top of viewport

    const updateActive = () => {
      let current = elements[0]!.id;
      for (const el of elements) {
        if (el.getBoundingClientRect().top - READING_LINE <= 0) {
          current = el.id;
        } else {
          break;
        }
      }
      setActiveSection(current);
    };

    updateActive();
    window.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", updateActive);
    return () => {
      window.removeEventListener("scroll", updateActive);
      window.removeEventListener("resize", updateActive);
    };
  }, []);

  const rows = data?.phase1 ?? null;

  const toBars = (levels: FactorLevel[] | null, suffix = ""): FactorBar[] | null =>
    levels?.map((l) => ({
      label: `${l.label}${suffix}`,
      value: l.estimate.mean,
      // FactorBars requires an interval; where the analysis omitted one, the
      // whisker collapses to the point estimate rather than being invented.
      ci: l.estimate.ci ?? [l.estimate.mean, l.estimate.mean],
    })) ?? null;

  const byStrategy = toBars(data?.byStrategy ?? null);
  const bySize = toBars(data?.bySize ?? null, " tok");

  return (
    <>
      <header className="mb-8">
        <p className={EYEBROW}>Results</p>
        <h1>What the experiment measured.</h1>
        <div className="mt-7 flex flex-wrap items-center gap-8">
          {rows && <ContactSheet rows={rows} winner={PHASE1_WINNER} />}
          <div className="min-w-65 flex-1">
            {/* Counts are interpolated from the parsed payloads, never
                hardcoded — and the provenance claim is only made when there is
                something below it to trace. */}
            <p className="text-ink-soft max-w-[46ch] text-[15px]">
              {rows
                ? `${rows.length} chunking configurations, two generators — every number below traces back to a stored run in Postgres.`
                : "Every figure below is read from the stored analysis results; nothing on this page is computed in the browser."}
            </p>
            <p className="text-muted-foreground mt-4.5 flex items-baseline gap-2.5 text-[11.5px] font-bold uppercase tracking-[0.12em]">
              Best configuration
              <span className="text-compare font-mono text-[13px] font-medium normal-case tracking-normal">
                {PHASE1_WINNER.strategy} × {PHASE1_WINNER.chunkSize} tok
              </span>
            </p>
          </div>
        </div>
      </header>

      {loadFailed && (
        <Alert variant="destructive" className="mb-8 border-dashed">
          <AlertTitle className="font-mono text-[11px] uppercase tracking-[0.14em]">
            Results unavailable
          </AlertTitle>
          <AlertDescription>
            Couldn't reach the results API. Check that the backend is running.
          </AlertDescription>
        </Alert>
      )}

      <CutMark />

      <div className="mt-10 grid items-start gap-10 md:grid-cols-[156px_minmax(0,1fr)]">
        <nav
          aria-label="Sections"
          className="md:sticky md:top-6 md:self-start"
        >
          <p className="text-foreground mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.12em]">
            Contents
          </p>
          <ol className="flex list-none flex-row flex-wrap gap-x-5 gap-y-1 p-0 md:flex-col md:gap-0.5">
            {SECTIONS.map((s) => {
              const isActive = activeSection === s.id;
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    aria-current={isActive ? "location" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      document
                        .getElementById(s.id)
                        ?.scrollIntoView({ behavior: "auto", block: "start" });
                      setActiveSection(s.id);
                      history.replaceState(null, "", `#${s.id}`);
                    }}
                    className={cn(
                      "flex gap-2 rounded px-2 py-1 text-[13px] no-underline transition-colors",
                      isActive
                        ? "bg-seq-1 text-foreground font-medium"
                        : "text-ink-soft hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[11.5px]",
                        isActive ? "text-seq-6" : "text-muted-foreground",
                      )}
                    >
                      {s.n}
                    </span>
                    {s.label}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-w-0">
          <Section
            id="sec-1"
            eyebrow="§1 · Phase 1 — Chunking"
            title={rows ? `All ${rows.length} configurations` : "All configurations"}
            lead="Mean per metric with bootstrap 95% CIs. Generator fixed to Llama 3.1 8B for all configurations. The winning row is marked."
          >
            {rows ? (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={cn(HEAD_CELL, "text-left")}>
                      Config
                    </TableHead>
                    {METRIC_COLUMNS.map((c) => (
                      <TableHead key={c.key} className={HEAD_CELL}>
                        {c.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const isWinner =
                      r.strategy === PHASE1_WINNER.strategy &&
                      r.chunkSize === PHASE1_WINNER.chunkSize;
                    return (
                      <TableRow
                        key={`${r.strategy}-${r.chunkSize}`}
                        className={cn(
                          isWinner && "bg-seq-1 shadow-[inset_3px_0_0_var(--ring)]",
                        )}
                      >
                        <TableCell
                          className={cn(
                            NUM_CELL,
                            "text-foreground text-left",
                            isWinner && "font-bold",
                          )}
                        >
                          {r.strategy} × {r.chunkSize}
                          {isWinner && (
                            <span className="text-ring font-bold"> ← winner</span>
                          )}
                        </TableCell>
                        {METRIC_COLUMNS.map((c) => {
                          const m = r[c.key];
                          return (
                            <TableCell
                              key={c.key}
                              className={cn(NUM_CELL, isWinner && "font-bold")}
                            >
                              {m === null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : c.key === "truthfulness" && m.ci ? (
                                formatMeanCI(m.mean, m.ci)
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span>{m.mean.toFixed(2)}</span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {m.ci
                                      ? `95% CI ${m.ci[0].toFixed(2)}–${m.ci[1].toFixed(2)} (n = ${m.n})`
                                      : `No CI — ${m.ciOmittedReason ?? "not computed"} (n = ${m.n})`}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
            ) : (
              <NoData what="Phase-1 configuration ranking" failed={loadFailed} />
            )}
          </Section>

          <CutMark />

          <Section
            id="sec-2"
            eyebrow="§2 · Phase 1 — Chunking"
            title="Truthfulness, strategy × size"
            lead="The headline CRAG-style score (accuracy − hallucination rate) across the full grid. Darker is better."
          >
            {rows ? (
              <Card className="p-7">
                <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_240px]">
                  <Heatmap rows={rows} highlight={PHASE1_WINNER} />
                  <div>
                    <p className={EYEBROW}>Scale</p>
                    <HeatmapScale rows={rows} />
                    <div className="bg-border my-5 h-px" />
                    <p className={EYEBROW}>Read it this way</p>
                    <p className="text-ink-soft text-[13.5px] leading-relaxed">
                      Darker cells score higher. The ringed cell,{" "}
                      <span className="text-foreground font-mono text-[12.5px]">
                        {PHASE1_WINNER.strategy} × {PHASE1_WINNER.chunkSize}
                      </span>
                      , is the configuration carried into Phase 2 — ranked first
                      on truthfulness.
                    </p>
                    {/* Separability is a stored result of the paired tests, not
                        something read off overlapping intervals. */}
                    {data?.bestVsRest && (
                      <p className="text-muted-foreground mt-3 text-[13px] leading-relaxed">
                        Separability is measured, not eyeballed: the winner was
                        tested against each of the other{" "}
                        {data.bestVsRest.nComparisons} configurations with paired
                        Wilcoxon tests{testQualifier(data.bestVsRest)}, of which{" "}
                        {data.bestVsRest.nSignificant} reached significance. The
                        analysis records it as: “{data.bestVsRest.interpretation}”
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            ) : (
              <NoData what="Phase-1 configuration ranking" failed={loadFailed} />
            )}
          </Section>

          <CutMark />

          <Section
            id="sec-3"
            eyebrow="§3 · Phase 1 — Chunking"
            title="Each factor in isolation"
            lead="Per-question scores averaged by strategy (across its three sizes) and by size (across the five strategies), with bootstrap 95% CI whiskers."
          >
            <div className="flex flex-col gap-5">
              {byStrategy ? (
                <Card className="gap-0 p-5">
                  <p className="text-[17px] font-semibold">By chunking strategy</p>
                  <p className="text-muted-foreground mb-4 mt-0.5 text-[12.5px]">mean truthfulness across sizes</p>
                  <FactorBars items={byStrategy} ariaLabel="Mean truthfulness by chunking strategy" />
                </Card>
              ) : (
                <NoData what="per-strategy factor analysis" failed={loadFailed} />
              )}
              {bySize ? (
                <Card className="gap-0 p-5">
                  <p className="text-[17px] font-semibold">By chunk size</p>
                  <p className="text-muted-foreground mb-4 mt-0.5 text-[12.5px]">mean truthfulness across strategies</p>
                  <FactorBars items={bySize} ariaLabel="Mean truthfulness by chunk size" />
                  <p className="bg-muted text-ink-soft mt-4 rounded-lg p-4 text-[13px] leading-relaxed">
                    Each bar averages the per-question scores of the configurations
                    sharing that level; the whiskers are the stored bootstrap 95%
                    CIs. Where the whisker collapses to a point, the analysis
                    recorded no interval — none is invented here.
                  </p>
                </Card>
              ) : (
                <NoData what="per-size factor analysis" failed={loadFailed} />
              )}
            </div>
          </Section>

          <CutMark />
          <Section
            id="sec-4"
            eyebrow="§4 · Phase 2 — Generators"
            title="Claude Opus 4.8 vs Llama 3.1 8B"
            lead={(() => {
              // The pre-declaration clause below ("fixed before any p-value
              // was seen") is not sourced from the payload — `paired.family`
              // lists the tested metrics but records nothing about when that
              // list was fixed. It states a real property of the experiment
              // design, kept as prose rather than removed, but it is not a
              // read from stored data the way the rest of this string is.
              //
              // `wilcoxonMethodPhrase` returns null both when the table is
              // absent and when the table's rows don't all share one real
              // test method (mixed exhaustive/Monte-Carlo, or a degenerate
              // all-zero-difference row) — a single sentence cannot name one
              // method in either case, so the fragment is simply omitted
              // rather than guessing. Per-row method detail lives in the p
              // (Holm) column's tooltip instead.
              const methodFragment = wilcoxonMethodPhrase(data?.phase2 ?? null);
              const testClause = methodFragment
                ? `Wilcoxon signed-rank p-values ${methodFragment} with Holm correction`
                : "Wilcoxon signed-rank p-values with Holm correction";
              return data?.phase2
                ? `Paired comparison over ${data.phase2.nQuestions} questions under the winning config. ${testClause}, applied across a metric family fixed before any p-value was seen.`
                : `Paired comparison under the winning config. ${testClause}, applied across a metric family fixed before any p-value was seen.`;
            })()}
          >
            {data?.phase2 ? (
              <>
                <PairedTableCard table={data.phase2} />
                <div className="text-ink-soft mt-3 flex flex-wrap gap-4 text-[12.5px]">
                  <Swatch className="bg-seq-5">significant at α = 0.05</Swatch>
                  <Swatch className="bg-seq-2">not significant</Swatch>
                </div>
                {data.phase2.rows.find((r) => r.floorNote)?.floorNote && (
                  <p className="bg-muted text-ink-soft mt-4 rounded-lg p-4 text-[13px] leading-relaxed">
                    {data.phase2.rows.find((r) => r.floorNote)!.floorNote}
                  </p>
                )}
              </>
            ) : (
              <NoData what="Phase-2 paired comparison" failed={loadFailed} />
            )}

            {data?.heldOut && (
              <div className="mt-8">
                <p className={EYEBROW}>
                  {data.heldOut.label} · n = {data.heldOut.nQuestions}
                </p>
                <PairedTableCard table={data.heldOut} showPValue={false} />
                <p className="bg-muted text-ink-soft mt-3 rounded-lg p-4 text-[13px] leading-relaxed">
                  {data.heldOut.rows[0]?.note}
                </p>
              </div>
            )}

            {data?.judge && (
              <Card className="mt-8 gap-0 p-6">
                <p className={EYEBROW}>Judge validation</p>
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                  <p className="text-foreground font-mono text-[34px] font-bold leading-none">
                    κ = {data.judge.kappa.toFixed(2)}
                  </p>
                  <Badge variant={data.judge.passes ? "default" : "destructive"}>
                    {data.judge.passes ? "gate passed" : "gate failed"}
                  </Badge>
                  <span className="text-muted-foreground font-mono text-[12.5px]">
                    threshold {data.judge.threshold.toFixed(2)} · {data.judge.band}
                  </span>
                </div>
                <p className="text-ink-soft mt-4 max-w-[62ch] text-[13.5px] leading-relaxed">
                  {data.judge.interpretation}
                </p>
                <div className="text-muted-foreground mt-4 flex flex-wrap gap-6 font-mono text-[12.5px]">
                  {data.judge.percentAgreement !== null && (
                    <span>
                      {(data.judge.percentAgreement * 100).toFixed(0)}%{" "}
                      <span className="text-ink-soft">raw agreement</span>
                    </span>
                  )}
                  <span>
                    n = {data.judge.n} <span className="text-ink-soft">hand-labelled</span>
                  </span>
                  {data.judge.kappaCI && (
                    <span>
                      95% CI {data.judge.kappaCI[0].toFixed(2)}–{data.judge.kappaCI[1].toFixed(2)}
                    </span>
                  )}
                </div>
                {data.judge.caveats.length > 0 && (
                  <ul className="text-ink-soft mt-4 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-relaxed">
                    {data.judge.caveats.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </Section>

          <CutMark />

          <Section
            id="sec-5"
            eyebrow="§5 · Operational"
            title="Latency by stage"
            lead="Retrieval and generation timed separately per run; medians shown as the summary, full spread in the box plots below."
          >
            {data?.latency ? (
              <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_240px] md:items-start">
                <div className="flex flex-col gap-5">
                  <Card className="p-5">
                    <LatencyStacks samples={data.latency} />
                  </Card>
                  <Card className="p-5">
                    <LatencyBoxes samples={data.latency} />
                  </Card>
                </div>
                <div>
                  <div className="text-ink-soft flex flex-col gap-1.5 text-[12.5px]">
                    <Swatch color={RETRIEVAL_COLOR}>retrieval</Swatch>
                    <Swatch color={GENERATION_COLOR}>generation</Swatch>
                  </div>
                  <hr className="border-border my-4" />
                  <p className="text-muted-foreground mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.12em]">
                    Read it this way
                  </p>
                  <p className="text-ink-soft text-[13px] leading-relaxed">
                    Both arms retrieve the same chunks — same config, same k, same
                    embedder — so what the generators are given is identical and
                    the comparison in §4 is generation-only. The retrieval
                    medians still differ between the arms. The box plots show the
                    spread behind each median.
                  </p>
                </div>
              </div>
            ) : (
              <NoData what="Phase-2 latency" failed={loadFailed} />
            )}
          </Section>

          <CutMark />

          <Section
            id="sec-6"
            eyebrow="§6 · Operational"
            title="Token cost"
            lead="Total tokens across all Phase 2 runs, converted at published prices."
          >
            {data?.cost ? (
              <>
                <div className="flex flex-col gap-5">
                  {(() => {
                    const costs = data.cost;
                    const maxCost = Math.max(...costs.map((c) => c.costUSD));
                    return costs.map((r) => {
                      const isClaude = r.model.startsWith("claude");
                      const [name, note] = r.label.includes("(")
                        ? [r.label.split(" (")[0], `(${r.label.split(" (")[1]}`]
                        : [r.label, null];
                      return (
                        <Card key={r.model} className="gap-0 p-6">
                          <p className="text-[15px]">
                            <span className="text-foreground font-medium">{name}</span>
                            {note && (
                              <span className="text-muted-foreground ml-1.5">{note}</span>
                            )}
                          </p>
                          <p className="text-foreground mt-3 font-mono text-[38px] font-bold leading-none">
                            {r.costUSD === 0 ? "$0.00" : formatUSD(r.costUSD)}
                          </p>
                          {/* A zero-cost arm gets a sentence, not a zero-width bar:
                              "no marginal API cost" is not the same as "cheap". */}
                          {r.costUSD === 0 ? (
                            <p className="text-ink-soft mt-4 text-[13px] leading-relaxed">
                              {data.costNote ??
                                "Served locally — no marginal API cost is billed per run."}
                            </p>
                          ) : (
                            <div className="bg-border mt-5 h-2 w-full overflow-hidden rounded-full">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${maxCost > 0 ? Math.max((r.costUSD / maxCost) * 100, 1.5) : 0}%`,
                                  background: isClaude ? "var(--compare)" : "var(--seq-6)",
                                }}
                              />
                            </div>
                          )}
                          <div className="text-muted-foreground mt-4 flex gap-6 font-mono text-[12.5px]">
                            <span>
                              {r.inputTokens.toLocaleString()}{" "}
                              <span className="text-ink-soft">in</span>
                            </span>
                            <span>
                              {r.outputTokens.toLocaleString()}{" "}
                              <span className="text-ink-soft">out</span>
                            </span>
                          </div>
                        </Card>
                      );
                    });
                  })()}
                </div>
                {data.tokenComparabilityNote && (
                  <p className="bg-muted text-ink-soft mt-5 rounded-lg p-4 text-[13px] leading-relaxed">
                    {data.tokenComparabilityNote}
                  </p>
                )}
              </>
            ) : (
              <NoData what="Phase-2 token cost" failed={loadFailed} />
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

/** §4's paired comparison table. Every number is read from the stored payload:
 *  the bar widths are relative magnitudes of the stored deltas, and
 *  significance is whatever the Holm correction recorded.
 *
 *  `showPValue` is false for the held-out subset, whose `pRaw`/`pHolm` are
 *  `NaN` by design (n = 10 supports no inferential claim) — the column and
 *  the significance-tinted delta bar are dropped rather than rendering a
 *  p-value that was never computed. */
function PairedTableCard({
  table,
  showPValue = true,
}: {
  table: PairedTable;
  showPValue?: boolean;
}) {
  const maxDelta = Math.max(...table.rows.map((m) => Math.abs(m.delta.mean)), 1e-9);
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={cn(HEAD_CELL_LG, "text-left")}>Metric</TableHead>
            <TableHead className={HEAD_CELL_LG}>Llama 3.1 8B</TableHead>
            <TableHead className={HEAD_CELL_LG}>Claude Opus 4.8</TableHead>
            <TableHead className={cn(HEAD_CELL_LG, "text-left")}>
              Δ Opus − Llama
            </TableHead>
            <TableHead className={HEAD_CELL_LG}>W–L–T</TableHead>
            {showPValue && <TableHead className={HEAD_CELL_LG}>p (Holm)</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((m) => {
            const deltaFrac = Math.abs(m.delta.mean) / maxDelta;
            return (
              <TableRow key={m.metric}>
                <TableCell className={cn(NUM_CELL_LG, "text-foreground text-left")}>
                  {m.label}
                </TableCell>
                <TableCell className={NUM_CELL_LG}>
                  <MeanCI value={m.llama} />
                </TableCell>
                <TableCell className={NUM_CELL_LG}>
                  <MeanCI
                    value={m.opus}
                    strong={
                      m.llama !== null &&
                      m.opus !== null &&
                      m.opus.mean > m.llama.mean
                    }
                  />
                </TableCell>
                <TableCell className={cn(NUM_CELL_LG, "text-left")}>
                  <div className="flex items-center gap-3">
                    <div className="bg-muted h-3 w-40 overflow-hidden rounded-full">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          showPValue
                            ? m.significant
                              ? "bg-seq-5"
                              : "bg-seq-2"
                            : "bg-seq-3",
                        )}
                        style={{ width: `${deltaFrac * 100}%` }}
                      />
                    </div>
                    <span className="text-foreground">
                      {m.delta.mean >= 0 ? "+" : ""}
                      {m.delta.mean.toFixed(2)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={NUM_CELL_LG}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono">
                        {m.wins}–{m.losses}–{m.ties}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {`Opus wins – Llama wins – ties, over ${m.nPairs} paired questions`}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                {showPValue && (
                  <TableCell className={NUM_CELL_LG}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={
                            m.significant
                              ? "bg-seq-1 text-seq-6 rounded px-2 py-0.5 font-semibold"
                              : "text-muted-foreground"
                          }
                        >
                          {m.pHolm.toFixed(3)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {m.method === NO_TEST_METHOD
                          ? `No test was run — all ${m.nPairs} paired differences were zero, so p is reported as 1.0 by convention, not computed.`
                          : m.method
                            ? `p_raw = ${m.pRaw.toFixed(5)}, via ${m.method}`
                            : `p_raw = ${m.pRaw.toFixed(5)}`}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="scroll-mt-6 pb-14 pt-8"
    >
      <p className={EYEBROW}>{eyebrow}</p>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className="text-ink-soft mb-6 mt-2 max-w-[64ch] text-[14.5px]">
        {lead}
      </p>
      {children}
    </section>
  );
}
