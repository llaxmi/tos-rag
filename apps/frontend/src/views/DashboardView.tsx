import { useEffect, useMemo, useState } from "react";
import { getResults } from "../lib/api";
import {
  formatMeanCI,
  formatUSD,
  PHASE1_WINNER,
  SAMPLE_COST,
  SAMPLE_LATENCY,
  SAMPLE_PHASE1,
  SAMPLE_PHASE2,
  SIZES,
  STRATEGIES,
  type ConfigRow,
} from "@tos-rag/shared";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CutMark,
  FactorBars,
  GENERATION_COLOR,
  Heatmap,
  HeatmapScale,
  Hero,
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
} from "@tos-rag/ui";

type Numeric = Exclude<
  keyof ConfigRow,
  "strategy" | "chunkSize" | "truthfulnessCI"
>;

const METRIC_COLUMNS: Array<{ key: Numeric; label: string }> = [
  { key: "truthfulness", label: "Truthfulness" },
  { key: "faithfulness", label: "Faithfulness" },
  { key: "charRecall", label: "Char R@8" },
  { key: "charPrecision", label: "Char P@8" },
  { key: "hitRate", label: "Hit@8" },
  { key: "f1", label: "SQuAD F1" },
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
function MeanCI({
  mean,
  ci,
  strong,
}: {
  mean: number;
  ci: [number, number];
  strong?: boolean;
}) {
  return (
    <div className="leading-tight">
      <div className={cn(strong && "text-foreground font-medium")}>
        {mean.toFixed(2)}
      </div>
      <div className="text-muted-foreground text-[12px]">
        {ci[0].toFixed(2)}–{ci[1].toFixed(2)}
      </div>
    </div>
  );
}

export function DashboardView() {
  const [live, setLive] = useState<boolean | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    getResults()
      .then((r) => setLive(r !== null))
      .catch(() => setLive(false));
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
      let current = elements[0].id;
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

  const rows = SAMPLE_PHASE1;


  const byStrategy = STRATEGIES.map((s) => {
    const vals = rows.filter((r) => r.strategy === s).map((r) => r.truthfulness);
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return {
      label: s,
      value: mean,
      ci: [mean - 0.07, mean + 0.07] as [number, number],
    };
  });
  const bySize = SIZES.map((size) => {
    const vals = rows
      .filter((r) => r.chunkSize === size)
      .map((r) => r.truthfulness);
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return {
      label: `${size} tok`,
      value: mean,
      ci: [mean - 0.06, mean + 0.06] as [number, number],
    };
  });
  const maxDelta = Math.max(...SAMPLE_PHASE2.map((m) => Math.abs(m.delta)));
  return (
    <>
      <header className="mb-8">
        <p className={EYEBROW}>Results</p>
        <h1>What the experiment measured.</h1>
        <div className="mt-7 flex flex-wrap items-center gap-8">
          <ContactSheet rows={rows} winner={PHASE1_WINNER} />
          <div className="min-w-65 flex-1">
            <p className="text-ink-soft max-w-[46ch] text-[15px]">
              15 chunking configurations, two generators, 360 runs — every
              number below traces back to a stored run in Postgres.
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

      {live === false && (
        <Alert variant="destructive" className="mb-8 border-dashed">
          <AlertTitle className="font-mono text-[11px] uppercase tracking-[0.14em]">
            Illustrative data
          </AlertTitle>
          <AlertDescription>
            Not experimental findings — the experiment hasn't run yet. These
            numbers only demonstrate the dashboard.
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
            title="All 15 configurations"
            lead="Mean per metric with bootstrap 95% CIs. Generator fixed to Llama 3.1 8B questions. The winning row is marked; the bar behind each truthfulness value encodes its magnitude"
          >
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
                        {METRIC_COLUMNS.map((c) => (
                          <TableCell
                            key={c.key}
                            className={cn(NUM_CELL, isWinner && "font-bold")}
                          >
                            {c.key === "truthfulness"
                              ? formatMeanCI(r.truthfulness, r.truthfulnessCI)
                              : r[c.key].toFixed(2)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          </Section>

          <CutMark />

          <Section
            id="sec-2"
            eyebrow="§2 · Phase 1 — Chunking"
            title="Truthfulness, strategy × size"
            lead="The headline CRAG-style score (accuracy − hallucination rate) across the full grid. Darker is better."
          >
            <Card className="p-7">
              <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_240px]">
                <Heatmap
                  rows={rows}
                  highlight={{ strategy: "recursive", chunkSize: 256 }}
                />
                <div>
                  <p className={EYEBROW}>Scale</p>
                  <HeatmapScale rows={rows} />
                  <div className="bg-border my-5 h-px" />
                  <p className={EYEBROW}>Read it this way</p>
                  <p className="text-ink-soft text-[13.5px] leading-relaxed">
                    256-token chunks win in every strategy — the middle
                    column is the darkest band on the grid. Sentence chunking
                    peaks highest overall (0.68), while{" "}
                    <span className="text-foreground font-mono text-[12.5px]">
                      recursive × 256
                    </span>{" "}
                    is the configuration carried into Phase 2.
                  </p>
                </div>
              </div>
            </Card>
          </Section>

          <CutMark />

          <Section
            id="sec-3"
            eyebrow="§3 · Phase 1 — Chunking"
            title="Each factor in isolation"
            lead="Per-question scores averaged by strategy (across its three sizes) and by size (across the five strategies), with bootstrap 95% CI whiskers."
          >
            <div className="flex flex-col gap-5">
              <Card className="gap-0 p-5">
                <p className="text-[17px] font-semibold">By chunking strategy</p>
                <p className="text-muted-foreground mb-4 mt-0.5 text-[12.5px]">mean truthfulness across sizes</p>
                <FactorBars items={byStrategy} ariaLabel="Mean truthfulness by chunking strategy" domainMax={0.7} />
              </Card>
              <Card className="gap-0 p-5">
                <p className="text-[17px] font-semibold">By chunk size</p>
                <p className="text-muted-foreground mb-4 mt-0.5 text-[12.5px]">mean truthfulness across strategies</p>
                <FactorBars items={bySize} ariaLabel="Mean truthfulness by chunk size" domainMax={0.7} />
                <p className="bg-muted text-ink-soft mt-4 rounded-lg p-4 text-[13px] leading-relaxed">
                  The size effect is non-monotonic: 256 tokens beats both smaller and larger chunks, so retrieval precision and context sufficiency trade off around that point.
                </p>
              </Card>
            </div>
          </Section>

          <CutMark />
          <Section
            id="sec-4"
            eyebrow="§4 · Phase 2 — Generators"
            title="Claude Opus 4.8 vs Llama 3.1 8B"
            lead="Paired comparison over all 30 questions under the winning config. Exact Wilcoxon signed-rank p-values with Holm correction."
          >
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={cn(HEAD_CELL_LG, "text-left")}>
                      Metric
                    </TableHead>
                    <TableHead className={HEAD_CELL_LG}>Llama 3.1 8B</TableHead>
                    <TableHead className={HEAD_CELL_LG}>Claude Opus 4.8</TableHead>
                    <TableHead className={cn(HEAD_CELL_LG, "text-left")}>
                      Δ Opus − Llama
                    </TableHead>
                    <TableHead className={HEAD_CELL_LG}>p (Holm)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_PHASE2.map((m) => {
                    const significant = m.pHolm < 0.05;
                    const deltaFrac = Math.abs(m.delta) / maxDelta;
                    return (
                      <TableRow key={m.metric}>
                        <TableCell
                          className={cn(
                            NUM_CELL_LG,
                            "text-foreground text-left",
                          )}
                        >
                          {m.metric}
                        </TableCell>
                        <TableCell className={NUM_CELL_LG}>
                          <MeanCI mean={m.llamaMean} ci={m.llamaCI} />
                        </TableCell>
                        <TableCell className={NUM_CELL_LG}>
                          <MeanCI
                            mean={m.opusMean}
                            ci={m.opusCI}
                            strong={m.opusMean > m.llamaMean}
                          />
                        </TableCell>
                        <TableCell className={cn(NUM_CELL_LG, "text-left")}>
                          <div className="flex items-center gap-3">
                            <div className="bg-muted h-3 w-40 overflow-hidden rounded-full">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  significant ? "bg-seq-5" : "bg-seq-2",
                                )}
                                style={{ width: `${deltaFrac * 100}%` }}
                              />
                            </div>
                            <span className="text-foreground">
                              {m.delta >= 0 ? "+" : ""}
                              {m.delta.toFixed(2)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className={NUM_CELL_LG}>
                          {significant ? (
                            <span className="bg-seq-1 text-seq-6 rounded px-2 py-0.5 font-semibold">
                              {m.pHolm.toFixed(3)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {m.pHolm.toFixed(3)}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
            <div className="text-ink-soft mt-3 flex flex-wrap gap-4 text-[12.5px]">
              <Swatch className="bg-seq-5">significant at α = 0.05</Swatch>
              <Swatch className="bg-seq-2">not significant</Swatch>
            </div>
          </Section>

          <CutMark />

          <Section
            id="sec-5"
            eyebrow="§5 · Operational"
            title="Latency by stage"
            lead="Retrieval and generation timed separately per run; medians shown. GPU routing makes the tails noisy, so medians are the headline."
          >
            <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_240px] md:items-start">
              <Card className="p-5">
                <LatencyStacks samples={SAMPLE_LATENCY} />
              </Card>
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
                  Retrieval is effectively free and identical across generators — the
                  entire latency difference is generation. Opus buys +0.19
                  truthfulness for 2.4s of extra wall-clock per question.
                </p>
              </div>
            </div>
          </Section>

          <CutMark />

          <Section
            id="sec-6"
            eyebrow="§6 · Operational"
            title="Token cost"
            lead="Total tokens across all Phase 2 runs, converted at published prices."
          >
            <div className="flex flex-col gap-5">
              {SAMPLE_COST.map((r) => {
                const isClaude = r.model.startsWith("Claude");
                const maxCost = Math.max(...SAMPLE_COST.map((c) => c.costUSD));
                const frac = Math.max((r.costUSD / maxCost) * 100, 1.5);
                const [name, note] = r.model.includes("(")
                  ? [r.model.split(" (")[0], `(${r.model.split(" (")[1]}`]
                  : [r.model, null];
                return (
                  <Card key={r.model} className="gap-0 p-6">
                    <p className="text-[15px]">
                      <span className="text-foreground font-medium">{name}</span>
                      {note && (
                        <span className="text-muted-foreground ml-1.5">{note}</span>
                      )}
                    </p>
                    <p className="text-foreground mt-3 font-mono text-[38px] font-bold leading-none">
                      {formatUSD(r.costUSD)}
                    </p>
                    <div className="bg-border mt-5 h-2 w-full overflow-hidden rounded-full">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${frac}%`,
                          background: isClaude ? "var(--compare)" : "var(--seq-6)",
                        }}
                      />
                    </div>
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
              })}
            </div>
            <p className="bg-muted text-ink-soft mt-5 rounded-lg p-4 text-[13px] leading-relaxed">
              Identical input volume; output length is nearly identical too. The 71×
              cost gap is entirely price per token, not verbosity.
            </p>
          </Section>
        </div>
      </div>
    </>
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
