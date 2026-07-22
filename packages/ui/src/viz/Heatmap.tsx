import { heatColor, SEQ_DARK_FROM, SEQ_RAMP } from "@tos-rag/shared";
import { SIZES, STRATEGIES, type ConfigRow } from "@tos-rag/shared";

interface Cell {
  strategy: string;
  chunkSize: number;
}

/** Dark ramp steps need light value labels (docs/design.md §3). */
const inkFor = (color: string) =>
  SEQ_RAMP.indexOf(color) >= SEQ_DARK_FROM ? "var(--background)" : "var(--foreground)";

const findCell = (rows: ConfigRow[], strategy: string, size: number) =>
  rows.find((r) => r.strategy === strategy && r.chunkSize === size);

const extent = (rows: ConfigRow[]): [number, number] => {
  const values = rows.map((r) => r.truthfulness);
  return [Math.min(...values), Math.max(...values)];
};

/** 5×3 strategy-by-size heatmap of Truthfulness (PRD §12.2). */
export function Heatmap({ rows }: { rows: ConfigRow[] }) {
  const [min, max] = extent(rows);

  const cellW = 96;
  const cellH = 44;
  const labelW = 88;
  const headH = 26;
  const width = labelW + cellW * SIZES.length;
  const height = headH + cellH * STRATEGIES.length;

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
          fill="var(--muted-foreground)"
        >
          {size} tok
        </text>
      ))}
      {STRATEGIES.map((strategy, i) => (
        <g key={strategy}>
          <text
            className="mono"
            x={labelW - 10}
            y={headH + i * cellH + cellH / 2 + 4}
            textAnchor="end"
            fontSize="12.5"
            fill="var(--ink-soft)"
          >
            {strategy}
          </text>
          {SIZES.map((size, j) => {
            const r = findCell(rows, strategy, size);
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
                  stroke="var(--border)"
                  strokeWidth="1"
                  className="heat-cell"
                  style={{ animationDelay: `${(i * SIZES.length + j) * 20}ms` }}
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

/**
 * The same 15 cells at thumbnail scale — the dashboard hero (docs/design.md §5).
 * States the shape of the sweep before any number is read; the winning cell is
 * ringed. The table below carries the values, so this is decorative to a screen
 * reader by design.
 */
export function ContactSheet({
  rows,
  winner,
}: {
  rows: ConfigRow[];
  winner: Cell;
}) {
  const [min, max] = extent(rows);

  const cellW = 26;
  const cellH = 20;
  const gap = 3;
  const width = SIZES.length * cellW + (SIZES.length - 1) * gap;
  const height = STRATEGIES.length * cellH + (STRATEGIES.length - 1) * gap;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="contact-sheet"
      aria-hidden="true"
      focusable="false"
    >
      {STRATEGIES.map((strategy, i) =>
        SIZES.map((size, j) => {
          const r = findCell(rows, strategy, size);
          if (!r) return null;
          const isWinner =
            strategy === winner.strategy && size === winner.chunkSize;
          const x = j * (cellW + gap);
          const y = i * (cellH + gap);
          return (
            <g key={`${strategy}-${size}`}>
              <rect
                x={x}
                y={y}
                width={cellW}
                height={cellH}
                rx="2"
                fill={heatColor(r.truthfulness, min, max)}
                className="heat-cell"
                style={{ animationDelay: `${(i * SIZES.length + j) * 20}ms` }}
              />
              {isWinner && (
                <rect
                  x={x - 2}
                  y={y - 2}
                  width={cellW + 4}
                  height={cellH + 4}
                  rx="4"
                  fill="none"
                  stroke="var(--compare)"
                  strokeWidth="1.5"
                />
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}
