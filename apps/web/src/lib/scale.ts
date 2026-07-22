/**
 * Sequential blue ramp (dataviz reference palette): one hue, light→dark,
 * lightness-monotonic. Lightest step = smallest value.
 */
export const SEQ_RAMP: readonly string[] = [
  "#cde2fb",
  "#9ec5f4",
  "#6da7ec",
  "#3987e5",
  "#256abf",
  "#184f95",
  "#0d366b",
];

export function linearScale(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) return () => r0;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** Maps a value in [min, max] to a step of the sequential ramp. */
export function heatColor(value: number, min: number, max: number): string {
  if (max === min) return SEQ_RAMP[Math.floor(SEQ_RAMP.length / 2)]!;
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return SEQ_RAMP[Math.round(t * (SEQ_RAMP.length - 1))]!;
}

export interface BoxStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

/** Five-number summary with linearly interpolated quartiles. */
export function boxStats(values: readonly number[]): BoxStats {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    const pos = p * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!);
  };
  return {
    min: sorted[0]!,
    q1: q(0.25),
    median: q(0.5),
    q3: q(0.75),
    max: sorted[sorted.length - 1]!,
  };
}
