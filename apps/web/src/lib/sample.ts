/**
 * ILLUSTRATIVE SAMPLE DATA — not experimental findings.
 *
 * The dashboard renders from `analysis_results` in Postgres once the
 * experiment runs (PRD §11–12). Until then these plausible-but-invented
 * numbers demonstrate every figure; the UI shows a persistent banner
 * whenever they are displayed.
 */

export interface ConfigRow {
  strategy: string;
  chunkSize: number;
  truthfulness: number;
  truthfulnessCI: [number, number];
  faithfulness: number;
  charRecall: number;
  charPrecision: number;
  hitRate: number;
  f1: number;
}

export const STRATEGIES = ["fixed", "recursive", "sentence", "semantic", "section"] as const;
export const SIZES = [128, 256, 512] as const;

const base: Record<(typeof STRATEGIES)[number], number> = {
  fixed: 0.42,
  recursive: 0.51,
  sentence: 0.58,
  semantic: 0.55,
  section: 0.53,
};
const sizeBump: Record<(typeof SIZES)[number], number> = {
  128: -0.04,
  256: 0.06,
  512: 0.0,
};

export const SAMPLE_PHASE1: ConfigRow[] = STRATEGIES.flatMap((strategy) =>
  SIZES.map((chunkSize) => {
    const t = base[strategy] + sizeBump[chunkSize];
    const wiggle = ((strategy.length * chunkSize) % 7) / 100;
    const truthfulness = Math.round((t + wiggle) * 100) / 100;
    return {
      strategy,
      chunkSize,
      truthfulness,
      truthfulnessCI: [truthfulness - 0.09, truthfulness + 0.08] as [number, number],
      faithfulness: Math.min(0.97, truthfulness + 0.3),
      charRecall: Math.min(0.95, truthfulness + 0.22),
      charPrecision: Math.max(0.08, 0.34 - chunkSize / 4000),
      hitRate: Math.min(1, truthfulness + 0.35),
      f1: Math.max(0.05, truthfulness - 0.12),
    };
  }),
);

export const SAMPLE_WINNER = { strategy: "sentence", chunkSize: 256 };

export interface PairedMetricRow {
  metric: string;
  llamaMean: number;
  llamaCI: [number, number];
  opusMean: number;
  opusCI: [number, number];
  delta: number;
  deltaCI: [number, number];
  pHolm: number;
  winsLlama: number;
  winsOpus: number;
  ties: number;
}

export const SAMPLE_PHASE2: PairedMetricRow[] = [
  {
    metric: "Truthfulness",
    llamaMean: 0.63, llamaCI: [0.5, 0.74],
    opusMean: 0.82, opusCI: [0.71, 0.9],
    delta: 0.19, deltaCI: [0.07, 0.31], pHolm: 0.011,
    winsLlama: 4, winsOpus: 19, ties: 7,
  },
  {
    metric: "Faithfulness",
    llamaMean: 0.84, llamaCI: [0.76, 0.9],
    opusMean: 0.93, opusCI: [0.88, 0.97],
    delta: 0.09, deltaCI: [0.02, 0.16], pHolm: 0.031,
    winsLlama: 6, winsOpus: 16, ties: 8,
  },
  {
    metric: "SQuAD F1",
    llamaMean: 0.46, llamaCI: [0.37, 0.55],
    opusMean: 0.55, opusCI: [0.46, 0.63],
    delta: 0.09, deltaCI: [-0.01, 0.19], pHolm: 0.082,
    winsLlama: 9, winsOpus: 15, ties: 6,
  },
  {
    metric: "Answer–gold cosine",
    llamaMean: 0.71, llamaCI: [0.64, 0.77],
    opusMean: 0.78, opusCI: [0.72, 0.83],
    delta: 0.07, deltaCI: [0.01, 0.13], pHolm: 0.031,
    winsLlama: 8, winsOpus: 18, ties: 4,
  },
];

export interface LatencySample {
  model: "llama" | "opus";
  stage: "retrieval" | "generation";
  values: number[];
}

const spread = (median: number, iqr: number, n = 30): number[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * 2 - 1; // -1..1
    return Math.round(median + t * iqr * (0.5 + Math.abs(t)));
  });

export const SAMPLE_LATENCY: LatencySample[] = [
  { model: "llama", stage: "retrieval", values: spread(180, 60) },
  { model: "opus", stage: "retrieval", values: spread(185, 65) },
  { model: "llama", stage: "generation", values: spread(1400, 500) },
  { model: "opus", stage: "generation", values: spread(3800, 1400) },
];

export interface CostRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export const SAMPLE_COST: CostRow[] = [
  { model: "Llama 3.1 8B (Workers AI)", inputTokens: 61_000, outputTokens: 4_900, costUSD: 0.018 },
  { model: "Claude Opus 4.8", inputTokens: 61_000, outputTokens: 5_400, costUSD: 1.42 },
];
