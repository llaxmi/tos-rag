import { heatColor, SEQ_RAMP } from "../../lib/scale";
import { SIZES, STRATEGIES, type ConfigRow } from "../../lib/sample";

/** 5×3 strategy-by-size heatmap of Truthfulness (PRD §12.2). */
export function Heatmap({ rows }: { rows: ConfigRow[] }) {
  const values = rows.map((r) => r.truthfulness);
  const min = Math.min(...values);
  const max = Math.max(...values);

  const cellW = 96;
  const cellH = 44;
  const labelW = 88;
  const headH = 26;
  const width = labelW + cellW * SIZES.length;
  const height = headH + cellH * STRATEGIES.length;

  const cell = (strategy: string, size: number) =>
    rows.find((r) => r.strategy === strategy && r.chunkSize === size);

  // dark ramp steps need light value labels
  const inkFor = (color: string) =>
    SEQ_RAMP.indexOf(color) >= 3
      ? "#ffffff"
      : "#232b36";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width }}
      role="img"
      aria-label="Truthfulness by chunking strategy and chunk size"
    >
      {SIZES.map((size, j) => (
        <text
          key={size}
          className="mono"
          x={labelW + j * cellW + cellW / 2}
          y={headH - 10}
          textAnchor="middle"
          fontSize="11.5"
          fill="#8b9099"
        >
          {size} tok
        </text>
      ))}
      {STRATEGIES.map((strategy, i) => (
        <g key={strategy}>
          <text
            x={labelW - 10}
            y={headH + i * cellH + cellH / 2 + 4}
            textAnchor="end"
            fontSize="12.5"
            fill="#5a6270"
          >
            {strategy}
          </text>
          {SIZES.map((size, j) => {
            const r = cell(strategy, size);
            if (!r) return null;
            const color = heatColor(r.truthfulness, min, max);
            return (
              <g key={size}>
                <rect
                  x={labelW + j * cellW + 1}
                  y={headH + i * cellH + 1}
                  width={cellW - 2}
                  height={cellH - 2}
                  rx="3"
                  fill={color}
                >
                  <title>
                    {strategy} × {size} tokens — truthfulness{" "}
                    {r.truthfulness.toFixed(2)}
                  </title>
                </rect>
                <text
                  className="mono"
                  x={labelW + j * cellW + cellW / 2}
                  y={headH + i * cellH + cellH / 2 + 4}
                  textAnchor="middle"
                  fontSize="12"
                  fill={inkFor(color)}
                >
                  {r.truthfulness.toFixed(2)}
                </text>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}
