/**
 * Sequential white→navy ramp: one hue, lightness-monotonic.
 * Lightest step = smallest value. Mirrors --seq-0…--seq-6 in styles.css;
 * the two must move together (docs/design.md §3).
 */
export const SEQ_RAMP: readonly string[] = [
  "#EEF3F9",
  "#D3E0EE",
  "#AFC6DE",
  "#85A5C9",
  "#4A73A3",
  "#33588A",
  "#0B1F3A",
];

/** Ramp index at and above which a value label needs light ink to stay legible. */
export const SEQ_DARK_FROM = 4;

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
