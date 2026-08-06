import { boxStats, formatMs, linearScale, MODEL_LABELS } from "@tos-rag/shared";
import type { LatencySample } from "@tos-rag/shared";

/** Light blue for the (small, fast) retrieval stage. */
export const RETRIEVAL_COLOR = "var(--seq-2)";
/** Medium blue for the (larger, slower) generation stage. */
export const GENERATION_COLOR = "var(--seq-4)";
const TRACK_COLOR = "var(--seq-0)";
const LABEL2_X = 190;

interface ModelTotals {
  model: "llama" | "opus";
  retrievalMs: number;
  generationMs: number;
}

export function LatencyStacks({ samples }: { samples: LatencySample[] }) {
  const models = ["llama", "opus"] as const;
  const rows: ModelTotals[] = models.map((model) => ({
    model,
    retrievalMs: boxStats(
      samples.find((s) => s.model === model && s.stage === "retrieval")!.values,
    ).median,
    generationMs: boxStats(
      samples.find((s) => s.model === model && s.stage === "generation")!.values,
    ).median,
  }));

  const width = 500;
  const barH = 30;
  const rowGap = 92;
  const topPad = 8;
  const axisH = 22;
  const height = topPad + rows.length * rowGap + axisH;

  const domainMaxMs = Math.ceil(
    Math.max(...rows.map((r) => r.retrievalMs + r.generationMs)) * 1.05,
  );
  const x = linearScale([0, domainMaxMs], [0, width]);

  const wholeSecTicks: number[] = [];
  for (let s = 0; s * 1000 < domainMaxMs * 0.9; s++) wholeSecTicks.push(s * 1000);
  const ticks = [...wholeSecTicks, domainMaxMs];
  const axisY = topPad + rows.length * rowGap + 6;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, display: "block" }}
      role="img"
      aria-label="Median latency by stage, per model"
    >
      {rows.map((r, i) => {
        const y = topPad + i * rowGap;
        const barY = y + 24;
        const totalMs = r.retrievalMs + r.generationMs;
        const retrievalW = x(r.retrievalMs);
        const genEndX = x(totalMs);
        const clipId = `latency-clip-${r.model}`;
        return (
          <g key={r.model}>
            <text className="mono" x={0} y={y + 14} fontSize="14" fill="var(--foreground)">
              {MODEL_LABELS[r.model]}
            </text>
            <text className="mono" x={width} y={y + 14} fontSize="14" fontWeight="600" textAnchor="end" fill="var(--foreground)">
              {formatMs(totalMs)}
            </text>

            <rect x={0} y={barY} width={width} height={barH} rx="6" fill={TRACK_COLOR} stroke="var(--border)" strokeWidth="1" />

            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={barY} width={genEndX} height={barH} rx="6" />
              </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`}>
              <rect x={0} y={barY} width={retrievalW} height={barH} fill={RETRIEVAL_COLOR}>
                <title>{MODEL_LABELS[r.model]} retrieval: {formatMs(r.retrievalMs)}</title>
              </rect>
              <rect x={retrievalW} y={barY} width={Math.max(0, genEndX - retrievalW)} height={barH} fill={GENERATION_COLOR}>
                <title>{MODEL_LABELS[r.model]} generation: {formatMs(r.generationMs)}</title>
              </rect>
            </g>

            <text className="mono" x={0} y={barY + barH + 18} fontSize="12" fill="var(--muted-foreground)">
              retrieval {formatMs(r.retrievalMs)}
            </text>
            <text className="mono" x={LABEL2_X} y={barY + barH + 18} fontSize="12" fill="var(--muted-foreground)">
              generation {formatMs(r.generationMs)}
            </text>
          </g>
        );
      })}

      <line x1={0} x2={width} y1={axisY} y2={axisY} stroke="var(--border)" strokeWidth="1" />
      {ticks.map((t) => (
        <text key={t} className="mono" x={x(t)} y={axisY + 15} textAnchor={t === 0 ? "start" : t === domainMaxMs ? "end" : "middle"} fontSize="11" fill="var(--muted-foreground)">
          {t % 1000 === 0 ? `${t / 1000}s` : `${(t / 1000).toFixed(1)}s`}
        </text>
      ))}
    </svg>
  );
}