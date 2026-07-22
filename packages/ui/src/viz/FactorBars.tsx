import { linearScale } from "@tos-rag/shared";

export interface FactorBar {
  label: string;
  value: number;
  ci: [number, number];
}

/**
 * Single-series bar chart with bootstrap-CI whiskers (PRD §12.3).
 * One hue for magnitude; the whisker sits a few ramp steps darker than the bar
 * so it stays readable where it overlaps (docs/design.md §3).
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
              className="mono"
              x={labelW - 10}
              y={y + barH / 2 + 4}
              textAnchor="end"
              fontSize="12.5"
              fill="var(--ink-soft)"
            >
              {item.label}
            </text>
            <rect
              x={x(0)}
              y={y}
              width={Math.max(0, x(item.value) - x(0))}
              height={barH}
              rx="4"
              fill="var(--seq-4)"
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
              stroke="var(--foreground)"
              strokeWidth="1.5"
            />
            <line
              x1={x(item.ci[0])}
              x2={x(item.ci[0])}
              y1={y + barH / 2 - 5}
              y2={y + barH / 2 + 5}
              stroke="var(--foreground)"
              strokeWidth="1.5"
            />
            <line
              x1={x(item.ci[1])}
              x2={x(item.ci[1])}
              y1={y + barH / 2 - 5}
              y2={y + barH / 2 + 5}
              stroke="var(--foreground)"
              strokeWidth="1.5"
            />
            <text
              className="mono"
              x={width - valueW + 8}
              y={y + barH / 2 + 4}
              fontSize="12"
              fill="var(--foreground)"
            >
              {item.value.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
