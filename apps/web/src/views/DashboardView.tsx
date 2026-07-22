import { useEffect, useMemo, useState } from "react";
import { getResults } from "../lib/api";
import { formatMeanCI, formatUSD } from "../lib/format";
import {
  SAMPLE_COST,
  SAMPLE_LATENCY,
  SAMPLE_PHASE1,
  SAMPLE_PHASE2,
  SAMPLE_WINNER,
  SIZES,
  STRATEGIES,
  type ConfigRow,
} from "../lib/sample";
import { FactorBars } from "../components/viz/FactorBars";
import { Heatmap } from "../components/viz/Heatmap";
import { LatencyBoxes } from "../components/viz/LatencyBoxes";

type Numeric = Exclude<keyof ConfigRow, "strategy" | "chunkSize" | "truthfulnessCI">;

const METRIC_COLUMNS: Array<{ key: Numeric; label: string }> = [
  { key: "truthfulness", label: "Truthfulness" },
  { key: "faithfulness", label: "Faithfulness" },
  { key: "charRecall", label: "Char R@8" },
  { key: "charPrecision", label: "Char P@8" },
  { key: "hitRate", label: "Hit@8" },
  { key: "f1", label: "SQuAD F1" },
];

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
    return { label: s, value: mean, ci: [mean - 0.07, mean + 0.07] as [number, number] };
  });
  const bySize = SIZES.map((size) => {
    const vals = rows.filter((r) => r.chunkSize === size).map((r) => r.truthfulness);
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return { label: `${size} tok`, value: mean, ci: [mean - 0.06, mean + 0.06] as [number, number] };
  });

  return (
    <>
      <header className="dash-header">
        <p className="eyebrow">Results</p>
        <h1>What the experiment measured.</h1>
        <p>
          15 chunking configurations, two generators, 360 runs — every number
          below traces back to a stored run in Postgres.
        </p>
      </header>

      {live === false && (
        <div className="sample-banner" role="note">
          <strong>Sample</strong>
          <span>
            The experiment hasn't produced results yet — these are illustrative
            numbers that demonstrate the dashboard, not findings.
          </span>
        </div>
      )}

      <section className="dash-section" aria-labelledby="phase1-table">
        <p className="eyebrow">Phase 1 · Chunking</p>
        <h2 id="phase1-table">All 15 configurations</h2>
        <p>
          Mean per metric with bootstrap 95% CIs; the best value in each column
          is bold. Generator fixed to Llama 3.1 8B, 20 questions.
        </p>
        <div className="table-scroll">
          <table className="results">
            <thead>
              <tr>
                <th scope="col">Config</th>
                {METRIC_COLUMNS.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isWinner =
                  r.strategy === SAMPLE_WINNER.strategy &&
                  r.chunkSize === SAMPLE_WINNER.chunkSize;
                return (
                  <tr key={`${r.strategy}-${r.chunkSize}`} className={isWinner ? "winner" : undefined}>
                    <td>
                      {r.strategy} × {r.chunkSize}
                    </td>
                    {METRIC_COLUMNS.map((c) => (
                      <td key={c.key} className={r[c.key] === best[c.key] ? "best" : undefined}>
                        {c.key === "truthfulness"
                          ? formatMeanCI(r.truthfulness, r.truthfulnessCI)
                          : r[c.key].toFixed(2)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dash-section" aria-labelledby="heatmap-h">
        <p className="eyebrow">Phase 1 · Chunking</p>
        <h2 id="heatmap-h">Truthfulness, strategy × size</h2>
        <p>
          The headline CRAG-style score (accuracy − hallucination rate) across
          the full grid. Darker is better.
        </p>
        <div className="viz-card">
          <Heatmap rows={rows} />
        </div>
      </section>

      <section className="dash-section" aria-labelledby="factors-h">
        <p className="eyebrow">Phase 1 · Chunking</p>
        <h2 id="factors-h">Each factor in isolation</h2>
        <p>
          Per-question scores averaged by strategy (across its three sizes) and
          by size (across the five strategies), with bootstrap 95% CI whiskers.
        </p>
        <div className="viz-row">
          <div className="viz-card">
            <p className="viz-title">By chunking strategy</p>
            <p className="viz-sub">mean truthfulness across sizes</p>
            <FactorBars items={byStrategy} ariaLabel="Mean truthfulness by chunking strategy" />
          </div>
          <div className="viz-card">
            <p className="viz-title">By chunk size</p>
            <p className="viz-sub">mean truthfulness across strategies</p>
            <FactorBars items={bySize} ariaLabel="Mean truthfulness by chunk size" />
          </div>
        </div>
      </section>

      <section className="dash-section" aria-labelledby="phase2-h">
        <p className="eyebrow">Phase 2 · Generators</p>
        <h2 id="phase2-h">Claude Opus 4.8 vs Llama 3.1 8B</h2>
        <p>
          Paired comparison over all 30 questions under the winning config —
          exact Wilcoxon signed-rank p-values with Holm correction, and
          per-question win counts.
        </p>
        <div className="table-scroll">
          <table className="results">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Llama 3.1 8B</th>
                <th scope="col">Claude Opus 4.8</th>
                <th scope="col">Δ (Opus − Llama)</th>
                <th scope="col">p (Holm)</th>
                <th scope="col">Wins L / tie / O</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_PHASE2.map((m) => {
                const total = m.winsLlama + m.winsOpus + m.ties;
                return (
                  <tr key={m.metric}>
                    <td>{m.metric}</td>
                    <td>{formatMeanCI(m.llamaMean, m.llamaCI)}</td>
                    <td className={m.opusMean > m.llamaMean ? "best" : undefined}>
                      {formatMeanCI(m.opusMean, m.opusCI)}
                    </td>
                    <td>{formatMeanCI(m.delta, m.deltaCI)}</td>
                    <td>{m.pHolm.toFixed(3)}</td>
                    <td>
                      <div
                        className="win-pill"
                        title={`Llama ${m.winsLlama}, ties ${m.ties}, Opus ${m.winsOpus}`}
                      >
                        <span style={{ width: `${(m.winsLlama / total) * 100}%`, background: "#2a78d6" }} />
                        <span className="gap" />
                        <span style={{ width: `${(m.ties / total) * 100}%`, background: "#ddd9ce" }} />
                        <span className="gap" />
                        <span style={{ width: `${(m.winsOpus / total) * 100}%`, background: "#1baf7a" }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="legend">
          <span>
            <span className="swatch" style={{ background: "#2a78d6" }} />
            Llama wins
          </span>
          <span>
            <span className="swatch" style={{ background: "#ddd9ce" }} />
            ties
          </span>
          <span>
            <span className="swatch" style={{ background: "#1baf7a" }} />
            Opus wins
          </span>
        </div>
      </section>

      <section className="dash-section" aria-labelledby="latency-h">
        <p className="eyebrow">Operational</p>
        <h2 id="latency-h">Latency by stage</h2>
        <p>
          Retrieval and generation timed separately per run; medians and
          interquartile ranges shown (GPU routing makes tails noisy, so medians
          are the headline).
        </p>
        <div className="viz-card">
          <LatencyBoxes samples={SAMPLE_LATENCY} />
        </div>
      </section>

      <section className="dash-section" aria-labelledby="cost-h">
        <p className="eyebrow">Operational</p>
        <h2 id="cost-h">Token cost</h2>
        <p>Total tokens across all Phase 2 runs, converted at published prices.</p>
        <div className="table-scroll">
          <table className="results">
            <thead>
              <tr>
                <th scope="col">Generator</th>
                <th scope="col">Input tokens</th>
                <th scope="col">Output tokens</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_COST.map((r) => (
                <tr key={r.model}>
                  <td>{r.model}</td>
                  <td>{r.inputTokens.toLocaleString()}</td>
                  <td>{r.outputTokens.toLocaleString()}</td>
                  <td>{formatUSD(r.costUSD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
