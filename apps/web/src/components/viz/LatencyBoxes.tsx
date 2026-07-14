import { boxStats, linearScale } from "../../lib/scale";
import { formatMs } from "../../lib/format";
import type { LatencySample } from "../../lib/sample";

const MODEL_COLOR: Record<string, string> = {
  llama: "#2a78d6",
  opus: "#1baf7a",
};
const MODEL_LABEL: Record<string, string> = {
  llama: "Llama 3.1 8B",
  opus: "Claude Opus 4.8",
};

/**
 * Latency box plots (PRD §12.5). Retrieval and generation live on different
 * scales, so each stage is its own small multiple with its own axis — never
 * one shared axis (dataviz rule: two measures of different scale → two charts).
 */
export function LatencyBoxes({ samples }: { samples: LatencySample[] }) {
  const stages = ["retrieval", "generation"] as const;
  return (
    <>
      {stages.map((stage) => (
        <StageBoxes
          key={stage}
          stage={stage}
          samples={samples.filter((s) => s.stage === stage)}
        />
      ))}
      <div className="legend">
        <span>
          <span className="swatch" style={{ background: MODEL_COLOR["llama"] }} />
          Llama 3.1 8B
        </span>
        <span>
          <span className="swatch" style={{ background: MODEL_COLOR["opus"] }} />
          Claude Opus 4.8
        </span>
        <span>median tick, box = interquartile range, whiskers = min–max</span>
      </div>
    </>
  );
}

function StageBoxes({
  stage,
  samples,
}: {
  stage: string;
  samples: LatencySample[];
}) {
  const width = 560;
  const rowH = 40;
  const labelW = 128;
  const valueW = 70;
  const headH = 22;
  const height = headH + samples.length * rowH + 6;
  const maxX = Math.max(...samples.flatMap((s) => s.values)) * 1.06;
  const x = linearScale([0, maxX], [labelW, width - valueW]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, display: "block" }}
      role="img"
      aria-label={`${stage} latency by model`}
    >
      <text
        className="mono"
        x={0}
        y={14}
        fontSize="11.5"
        letterSpacing="0.1em"
        fill="#8b9099"
      >
        {stage.toUpperCase()}
      </text>
      {samples.map((s, i) => {
        const st = boxStats(s.values);
        const y = headH + i * rowH + 8;
        const mid = y + 10;
        const color = MODEL_COLOR[s.model]!;
        return (
          <g key={s.model}>
            <text
              x={labelW - 10}
              y={mid + 4}
              textAnchor="end"
              fontSize="12"
              fill="#5a6270"
            >
              {MODEL_LABEL[s.model]}
            </text>
            <line x1={x(st.min)} x2={x(st.q1)} y1={mid} y2={mid} stroke="#c3c2b7" strokeWidth="1.5" />
            <line x1={x(st.q3)} x2={x(st.max)} y1={mid} y2={mid} stroke="#c3c2b7" strokeWidth="1.5" />
            <line x1={x(st.min)} x2={x(st.min)} y1={mid - 5} y2={mid + 5} stroke="#c3c2b7" strokeWidth="1.5" />
            <line x1={x(st.max)} x2={x(st.max)} y1={mid - 5} y2={mid + 5} stroke="#c3c2b7" strokeWidth="1.5" />
            <rect
              x={x(st.q1)}
              y={mid - 9}
              width={Math.max(2, x(st.q3) - x(st.q1))}
              height={18}
              rx="3"
              fill={color}
              opacity="0.85"
            >
              <title>
                {MODEL_LABEL[s.model]} {stage}: median {formatMs(st.median)}, IQR{" "}
                {formatMs(st.q1)}–{formatMs(st.q3)}, max {formatMs(st.max)}
              </title>
            </rect>
            <line
              x1={x(st.median)}
              x2={x(st.median)}
              y1={mid - 9}
              y2={mid + 9}
              stroke="#ffffff"
              strokeWidth="2"
            />
            <text
              className="mono"
              x={width - valueW + 6}
              y={mid + 4}
              fontSize="11.5"
              fill="#232b36"
            >
              {formatMs(st.median)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
