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
/**
 * 5×3 strategy-by-size heatmap of Truthfulness (PRD §12.2).
 * `highlight` rings one cell in dark navy — used to call out the config
 * carried into the next phase, independent of which cell is darkest.
 */
export function Heatmap({
  rows,
  highlight,
}: {
  rows: ConfigRow[];
  highlight?: Cell;
}) {
  const [min, max] = extent(rows);

  const cellW = 118;
  const cellH = 56;
  const gap = 6;
  const labelW = 96;
  const headH = 34;
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
          y={headH - 14}
          textAnchor="middle"
          fontSize="12.5"
          fill="var(--muted-foreground)"
        >
          {size} tok
        </text>
      ))}
      {STRATEGIES.map((strategy, i) => (
        <g key={strategy}>
          <text
            className="mono"
            x={labelW - 14}
            y={headH + i * cellH + cellH / 2 + 4}
            textAnchor="end"
            fontSize="13"
            fill="var(--ink-soft)"
          >
            {strategy}
          </text>
          {SIZES.map((size, j) => {
            const r = findCell(rows, strategy, size);
            if (!r) return null;
            const color = heatColor(r.truthfulness, min, max);
            const x = labelW + j * cellW + gap / 2;
            const y = headH + i * cellH + gap / 2;
            const w = cellW - gap;
            const h = cellH - gap;
            const isHighlighted =
              highlight?.strategy === strategy && highlight?.chunkSize === size;
            return (
              <g key={size}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx="5"
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
                {isHighlighted && (
                  <rect
                    x={x - 2}
                    y={y - 2}
                    width={w + 4}
                    height={h + 4}
                    rx="7"
                    fill="none"
                    stroke="var(--seq-6)"
                    strokeWidth="1.4"
                  />
                )}
                <text
                  className="mono"
                  x={labelW + j * cellW + cellW / 2}
                  y={headH + i * cellH + cellH / 2 + 4}
                  textAnchor="middle"
                  fontSize="13"
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
 * Horizontal legend for the sequential ramp — "what does darker mean" next
 * to the heatmap. Endpoints are the row's min/max truthfulness rounded out
 * to the nearest 0.10 (0.41 → 0.40, 0.68 → 0.70), not the raw values —
 * cleaner numbers for a scale that's read at a glance.
 */
export function HeatmapScale({ rows }: { rows: ConfigRow[] }) {
  const [rawMin, rawMax] = extent(rows);
  const min = Math.floor(rawMin * 10) / 10;
  const max = Math.ceil(rawMax * 10) / 10;
  const gradient = `linear-gradient(to right, ${SEQ_RAMP.join(", ")})`;

  return (
    <div>
      <div
        className="h-2 w-full rounded-full"
        style={{ background: gradient }}
        role="img"
        aria-label={`Color scale from ${min.toFixed(2)} to ${max.toFixed(2)}`}
      />
      <div className="text-muted-foreground mt-1.5 flex justify-between font-mono text-[11px]">
        <span>{min.toFixed(2)}</span>
        <span>{max.toFixed(2)}</span>
      </div>
    </div>
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
