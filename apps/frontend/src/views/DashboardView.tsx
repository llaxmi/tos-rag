import { useEffect, useMemo, useState } from "react";
import { getResults } from "../lib/api";
import {
  formatMeanCI,
  formatUSD,
  SAMPLE_COST,
  SAMPLE_LATENCY,
  SAMPLE_PHASE1,
  SAMPLE_PHASE2,
  SAMPLE_WINNER,
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
  ContactSheet,
  CutMark,
  FactorBars,
  Heatmap,
  LatencyBoxes,
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

export function DashboardView() {
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    getResults()
      .then((r) => setLive(r !== null))
      .catch(() => setLive(false));
  }, []);

  const rows = SAMPLE_PHASE1;

  const best = useMemo(() => {
    const b = {} as Record<Numeric, number>;
    for (const { key } of METRIC_COLUMNS) {
      b[key] = Math.max(...rows.map((r) => r[key]));
    }
    return b;
  }, [rows]);

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

  return (
    <>
      <header className="mb-8">
        <p className={EYEBROW}>Results</p>
        <h1>What the experiment measured.</h1>
        <div className="mt-7 flex flex-wrap items-center gap-8">
          <ContactSheet rows={rows} winner={SAMPLE_WINNER} />
          <div className="min-w-65 flex-1">
            <p className="text-ink-soft max-w-[46ch] text-[15px]">
              15 chunking configurations, two generators, 360 runs — every
              number below traces back to a stored run in Postgres.
            </p>
            <p className="text-muted-foreground mt-4.5 flex items-baseline gap-2.5 text-[11.5px] font-bold uppercase tracking-[0.12em]">
              Best configuration
              <span className="text-compare font-mono text-[13px] font-medium normal-case tracking-normal">
                {SAMPLE_WINNER.strategy} × {SAMPLE_WINNER.chunkSize} tok
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
          <ol className="flex list-none flex-row flex-wrap gap-x-5 gap-y-1 p-0 md:flex-col md:gap-0.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="text-ink-soft hover:text-foreground flex gap-2 rounded py-1 text-[13px] no-underline"
                >
                  <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">
                    {s.n}
                  </span>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0">
          <Section
            id="sec-1"
            eyebrow="§1 · Phase 1 — Chunking"
            title="All 15 configurations"
            lead="Mean per metric with bootstrap 95% CIs; the best value in each column is marked. Generator fixed to Llama 3.1 8B, 20 questions."
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
                      r.strategy === SAMPLE_WINNER.strategy &&
                      r.chunkSize === SAMPLE_WINNER.chunkSize;
                    return (
                      <TableRow
                        key={`${r.strategy}-${r.chunkSize}`}
                        className={cn(isWinner && "bg-compare-wash")}
                      >
                        <TableCell
                          className={cn(NUM_CELL, "text-foreground text-left")}
                        >
                          {r.strategy} × {r.chunkSize}
                          {isWinner && (
                            <span className="text-ink-soft"> ← winner</span>
                          )}
                        </TableCell>
                        {METRIC_COLUMNS.map((c) => (
                          <TableCell
                            key={c.key}
                            className={cn(
                              NUM_CELL,
                              r[c.key] === best[c.key] &&
                                "bg-compare-wash text-foreground font-medium shadow-[inset_3px_0_0_var(--compare)]",
                            )}
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
            <Card className="p-5">
              <Heatmap rows={rows} />
            </Card>
          </Section>

          <CutMark />

          <Section
            id="sec-3"
            eyebrow="§3 · Phase 1 — Chunking"
            title="Each factor in isolation"
            lead="Per-question scores averaged by strategy (across its three sizes) and by size (across the five strategies), with bootstrap 95% CI whiskers."
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="gap-0 p-5">
                <p className="text-[17px] font-semibold">By chunking strategy</p>
                <p className="text-muted-foreground mb-4 mt-0.5 text-[12.5px]">
                  mean truthfulness across sizes
                </p>
                <FactorBars
                  items={byStrategy}
                  ariaLabel="Mean truthfulness by chunking strategy"
                />
              </Card>
              <Card className="gap-0 p-5">
                <p className="text-[17px] font-semibold">By chunk size</p>
                <p className="text-muted-foreground mb-4 mt-0.5 text-[12.5px]">
                  mean truthfulness across strategies
                </p>
                <FactorBars
                  items={bySize}
                  ariaLabel="Mean truthfulness by chunk size"
                />
              </Card>
            </div>
          </Section>

          <CutMark />

          <Section
            id="sec-4"
            eyebrow="§4 · Phase 2 — Generators"
            title="Claude Opus 4.8 vs Llama 3.1 8B"
            lead="Paired comparison over all 30 questions under the winning config — exact Wilcoxon signed-rank p-values with Holm correction, and per-question win counts."
          >
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={cn(HEAD_CELL, "text-left")}>
                      Metric
                    </TableHead>
                    <TableHead className={HEAD_CELL}>Llama 3.1 8B</TableHead>
                    <TableHead className={HEAD_CELL}>Claude Opus 4.8</TableHead>
                    <TableHead className={HEAD_CELL}>Δ (Opus − Llama)</TableHead>
                    <TableHead className={HEAD_CELL}>p (Holm)</TableHead>
                    <TableHead className={HEAD_CELL}>Wins L / tie / O</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_PHASE2.map((m) => {
                    const total = m.winsLlama + m.winsOpus + m.ties;
                    return (
                      <TableRow key={m.metric}>
                        <TableCell
                          className={cn(NUM_CELL, "text-foreground text-left")}
                        >
                          {m.metric}
                        </TableCell>
                        <TableCell className={NUM_CELL}>
                          {formatMeanCI(m.llamaMean, m.llamaCI)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            NUM_CELL,
                            m.opusMean > m.llamaMean &&
                              "bg-compare-wash text-foreground font-medium shadow-[inset_3px_0_0_var(--compare)]",
                          )}
                        >
                          {formatMeanCI(m.opusMean, m.opusCI)}
                        </TableCell>
                        <TableCell className={NUM_CELL}>
                          {formatMeanCI(m.delta, m.deltaCI)}
                        </TableCell>
                        <TableCell className={NUM_CELL}>
                          {m.pHolm.toFixed(3)}
                        </TableCell>
                        <TableCell className={NUM_CELL}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex h-3 min-w-30 cursor-default overflow-hidden rounded-full">
                                <span
                                  className="bg-primary block h-full"
                                  style={{
                                    width: `${(m.winsLlama / total) * 100}%`,
                                  }}
                                />
                                <span className="bg-card block h-full w-0.5" />
                                <span
                                  className="bg-border block h-full"
                                  style={{
                                    width: `${(m.ties / total) * 100}%`,
                                  }}
                                />
                                <span className="bg-card block h-full w-0.5" />
                                <span
                                  className="bg-compare block h-full"
                                  style={{
                                    width: `${(m.winsOpus / total) * 100}%`,
                                  }}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              Llama {m.winsLlama}, ties {m.ties}, Opus{" "}
                              {m.winsOpus}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
            <div className="text-ink-soft mt-3 flex flex-wrap gap-4 text-[12.5px]">
              <Swatch className="bg-primary">Llama wins</Swatch>
              <Swatch className="bg-border">ties</Swatch>
              <Swatch className="bg-compare">Opus wins</Swatch>
            </div>
          </Section>

          <CutMark />

          <Section
            id="sec-5"
            eyebrow="§5 · Operational"
            title="Latency by stage"
            lead="Retrieval and generation timed separately per run; medians and interquartile ranges shown (GPU routing makes tails noisy, so medians are the headline)."
          >
            <Card className="p-5">
              <LatencyBoxes samples={SAMPLE_LATENCY} />
            </Card>
          </Section>

          <CutMark />

          <Section
            id="sec-6"
            eyebrow="§6 · Operational"
            title="Token cost"
            lead="Total tokens across all Phase 2 runs, converted at published prices."
          >
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={cn(HEAD_CELL, "text-left")}>
                      Generator
                    </TableHead>
                    <TableHead className={HEAD_CELL}>Input tokens</TableHead>
                    <TableHead className={HEAD_CELL}>Output tokens</TableHead>
                    <TableHead className={HEAD_CELL}>Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_COST.map((r) => (
                    <TableRow key={r.model}>
                      <TableCell
                        className={cn(NUM_CELL, "text-foreground text-left")}
                      >
                        {r.model}
                      </TableCell>
                      <TableCell className={NUM_CELL}>
                        {r.inputTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className={NUM_CELL}>
                        {r.outputTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className={NUM_CELL}>
                        {formatUSD(r.costUSD)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
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
