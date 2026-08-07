/** "0.82 [0.76, 0.88]" — mean with bootstrap 95% CI (PRD §12). */
export function formatMeanCI(mean: number, ci?: [number, number]): string {
  const m = mean.toFixed(2);
  if (!ci) return m;
  return `${m} [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatUSD(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** A per-unit price, always to four places — "$0.0232 per correct answer".
 *
 *  Separate from `formatUSD`, which rounds anything at or above a cent to two
 *  places. That is right for a total but wrong for a unit rate: cost per correct
 *  answer ($0.0232) and marginal cost per correction ($0.1344) would both
 *  collapse to two digits and lose the precision the report cites. */
export function formatUnitUSD(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
