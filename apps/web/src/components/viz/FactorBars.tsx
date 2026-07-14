import { linearScale } from "../../lib/scale";

export interface FactorBar {
  label: string;
  value: number;
  ci: [number, number];
}

/**
 * Single-series bar chart with bootstrap-CI whiskers (PRD §12.3).
 * One hue for magnitude; value labels are the relief for light-hue contrast.
 */
export function FactorBars({
  items,
  ariaLabel,
}: {
  items: FactorBar[];
  ariaLabel: string;
}) {
  const width = 440;
  const barH = 26;
  const gap = 14;
  const labelW = 86;
  const valueW = 46;
  const height = items.length * (barH + gap) - gap + 8;
  const maxX = Math.max(...items.map((i) => i.ci[1])) * 1.05;
  const x = linearScale([0, maxX], [labelW, width - valueW]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width }}
      role="img"
      aria-label={ariaLabel}
    >
      {items.map((item, i) => {
        const y = i * (barH + gap) + 4;
        return (
          <g key={item.label}>
            <text
              x={labelW - 10}
              y={y + barH / 2 + 4}
              textAnchor="end"
              fontSize="12.5"
              fill="#5a6270"
            >
              {item.label}
            </text>
            <rect
              x={x(0)}
              y={y}
              width={Math.max(0, x(item.value) - x(0))}
              height={barH}
              rx="4"
              fill="#2a78d6"
            >
              <title>
                {item.label}: {item.value.toFixed(2)} [{item.ci[0].toFixed(2)},{" "}
                {item.ci[1].toFixed(2)}]
              </title>
            </rect>
            {/* 95% CI whisker */}
            <line
              x1={x(item.ci[0])}
              x2={x(item.ci[1])}
              y1={y + barH / 2}
              y2={y + barH / 2}
              stroke="#232b36"
              strokeWidth="1.5"
            />
            <line
              x1={x(item.ci[0])}
              x2={x(item.ci[0])}
              y1={y + barH / 2 - 5}
              y2={y + barH / 2 + 5}
              stroke="#232b36"
              strokeWidth="1.5"
            />
            <line
              x1={x(item.ci[1])}
              x2={x(item.ci[1])}
              y1={y + barH / 2 - 5}
              y2={y + barH / 2 + 5}
              stroke="#232b36"
              strokeWidth="1.5"
            />
            <text
              className="mono"
              x={width - valueW + 8}
              y={y + barH / 2 + 4}
              fontSize="12"
              fill="#232b36"
            >
              {item.value.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
