/**
 * View models for the results dashboard, parsed from `analysis_results`.
 *
 * Every field here corresponds to something the Python analysis step stored.
 * Nothing in this module computes a statistic — a number that is not in a
 * payload does not appear on the dashboard (PRD §12).
 */

import { CHUNK_SIZES, PHASE1_WINNER, STRATEGIES } from "@tos-rag/core";

import type { AnalysisRow } from "./types";

// The frozen experimental controls live in @tos-rag/core; re-exported here so
// the dashboard's grid axes stay in lockstep with the pipeline.
export { STRATEGIES, PHASE1_WINNER };
export const SIZES = CHUNK_SIZES;

/** A stored point estimate. `ci` is null when the analysis declined to compute
 *  one (zero variance, too few pairs); `ciOmittedReason` says why. */
export interface MetricValue {
  mean: number;
  ci: [number, number] | null;
  ciOmittedReason: string | null;
  n: number;
}

/** Box-plot input. Stored by the Python step; never derived in the browser. */
export interface FiveNumber {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  p95: number;
}

/** The six metrics reported per Phase-1 configuration. Keys are camelCase
 *  renames of the payload's snake_case metric names. */
export interface ConfigMetrics {
  truthfulness: MetricValue;      // crag_score
  faithfulness: MetricValue | null;
  charRecall: MetricValue | null;
  charPrecision: MetricValue | null;
  hitRate: MetricValue | null;    // hit_at_8, but k = 5
  squadF1: MetricValue;
}

export interface ConfigRow extends ConfigMetrics {
  rank: number;
  strategy: string;
  chunkSize: number;
  latency: { retrievalMs: FiveNumber; generationMs: FiveNumber } | null;
}

/** The winner tested against every other configuration (PRD §11). Whether the
 *  sweep separates its configurations at all is established by these paired
 *  tests, not by whether the per-config intervals happen to overlap. */
export interface BestVsRest {
  /** Descriptive fields are nullable rather than defaulted: the dashboard omits
   *  the fragment it cannot source. `alpha` in particular is a claimed
   *  significance threshold — defaulting it to the experiment's 0.05 would
   *  render a number the payload never carried. */
  winner: string | null;
  metric: string | null;
  nComparisons: number;
  nSignificant: number;
  alpha: number | null;
  correction: string | null;
  /** The analysis step's own one-sentence summary; rendered verbatim. */
  interpretation: string;
}

/** One level of an isolated factor (a strategy, or a chunk size). */
export interface FactorLevel {
  label: string;
  estimate: MetricValue;
  nConfigsAveraged: number;
}

/** One row of the Phase-2 paired table. */
export interface PairedMetricRow {
  metric: string;
  label: string;
  note: string;
  llama: MetricValue | null;
  opus: MetricValue | null;
  delta: MetricValue;
  pRaw: number;
  pHolm: number;
  significant: boolean;
  wins: number;
  losses: number;
  ties: number;
  nPairs: number;
  /** Why no effect size could reach significance at this discordance count.
   *  Null when the analysis did not record a floor. */
  floorNote: string | null;
  /** How the p-value was obtained — e.g. "permutation (monte carlo, seeded)"
   *  or "exact". Read verbatim from `wilcoxon.method`; never assume "exact"
   *  when this is absent. */
  method: string | null;
}

export interface PairedTable {
  label: string;
  nQuestions: number;
  rows: PairedMetricRow[];
}

export interface CostRow {
  model: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  nPricedRuns: number;
}

export interface LatencySample {
  model: "llama" | "opus";
  stage: "retrieval" | "generation";
  stats: FiveNumber;
}

export interface JudgeValidation {
  kappa: number;
  kappaCI: [number, number] | null;
  percentAgreement: number | null;
  n: number;
  band: string;
  threshold: number;
  passes: boolean;
  interpretation: string;
  /** Sampling caveats the analysis step recorded — e.g. that the validation
   *  sample is verdict-balanced, not proportional to the judged population.
   *  Rendered verbatim; never paraphrased. */
  caveats: string[];
}

export interface DashboardData {
  phase1: ConfigRow[] | null;
  winner: string | null;
  bestVsRest: BestVsRest | null;
  byStrategy: FactorLevel[] | null;
  bySize: FactorLevel[] | null;
  phase2: PairedTable | null;
  heldOut: PairedTable | null;
  latency: LatencySample[] | null;
  cost: CostRow[] | null;
  costNote: string | null;
  tokenComparabilityNote: string | null;
  judge: JudgeValidation | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Reads a stored `{mean, ci, n, ci_omitted_reason}` estimate.
 *  Returns null rather than substituting 0 — a missing metric is not a zero. */
function metric(v: unknown): MetricValue | null {
  if (!isRecord(v)) return null;
  const mean = num(v["mean"]);
  const n = num(v["n"]);
  if (mean === null || n === null) return null;
  let ci: [number, number] | null = null;
  if (isRecord(v["ci"])) {
    const low = num(v["ci"]["low"]);
    const high = num(v["ci"]["high"]);
    if (low !== null && high !== null) ci = [low, high];
  }
  return { mean, ci, ciOmittedReason: str(v["ci_omitted_reason"]), n };
}

function fiveNumber(v: unknown): FiveNumber | null {
  if (!isRecord(v)) return null;
  const keys = ["n", "min", "q1", "median", "q3", "max", "p95"] as const;
  const out = {} as Record<(typeof keys)[number], number>;
  for (const k of keys) {
    const parsed = num(v[k]);
    if (parsed === null) return null;
    out[k] = parsed;
  }
  return out as FiveNumber;
}

/** `"sentence:512"` → `{ strategy: "sentence", chunkSize: 512 }`. */
function splitConfig(id: string): { strategy: string; chunkSize: number } | null {
  const [strategy, size] = id.split(":");
  const chunkSize = Number(size);
  if (!strategy || !Number.isFinite(chunkSize)) return null;
  return { strategy, chunkSize };
}

function parseConfigRanking(payload: unknown): {
  rows: ConfigRow[];
  winner: string | null;
} | null {
  if (!isRecord(payload) || !Array.isArray(payload["configs"])) return null;
  const rows: ConfigRow[] = [];
  for (const raw of payload["configs"]) {
    if (!isRecord(raw)) continue;
    const id = str(raw["config"]);
    const rank = num(raw["rank"]);
    const m = isRecord(raw["metrics"]) ? raw["metrics"] : null;
    if (!id || rank === null || !m) continue;
    const split = splitConfig(id);
    const truthfulness = metric(m["crag_score"]);
    const squadF1 = metric(m["squad_f1"]);
    if (!split || !truthfulness || !squadF1) continue;

    const lat = isRecord(raw["latency_ms"]) ? raw["latency_ms"] : null;
    const retrievalMs = lat ? fiveNumber(lat["retrieval_ms"]) : null;
    const generationMs = lat ? fiveNumber(lat["generation_ms"]) : null;

    rows.push({
      rank,
      ...split,
      truthfulness,
      squadF1,
      faithfulness: metric(m["faithfulness"]),
      charRecall: metric(m["char_recall"]),
      charPrecision: metric(m["char_precision"]),
      hitRate: metric(m["hit_at_8"]),
      latency:
        retrievalMs && generationMs ? { retrievalMs, generationMs } : null,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.rank - b.rank);
  return { rows, winner: str(payload["winner"]) };
}

function parseBestVsRest(payload: unknown): BestVsRest | null {
  if (!isRecord(payload)) return null;
  const nComparisons = num(payload["n_comparisons"]);
  const nSignificant = num(payload["n_significant"]);
  const interpretation = str(payload["interpretation"]);
  if (nComparisons === null || nSignificant === null || !interpretation) return null;
  return {
    winner: str(payload["winner"]),
    metric: str(payload["metric"]),
    nComparisons,
    nSignificant,
    alpha: num(payload["alpha"]),
    correction: str(payload["correction"]),
    interpretation,
  };
}

function parseFactor(payload: unknown): FactorLevel[] | null {
  if (!isRecord(payload) || !Array.isArray(payload["levels"])) return null;
  const levels: FactorLevel[] = [];
  for (const raw of payload["levels"]) {
    if (!isRecord(raw)) continue;
    const label = str(raw["level"]) ?? String(raw["level"] ?? "");
    const estimate = metric(raw["estimate"]);
    if (!label || !estimate) continue;
    levels.push({
      label,
      estimate,
      nConfigsAveraged: num(raw["n_configs_averaged"]) ?? 0,
    });
  }
  return levels.length > 0 ? levels : null;
}

const LLAMA = "llama3.1:8b";
const OPUS = "claude-opus-4-8";

const METRIC_LABELS: Record<string, string> = {
  crag_score: "Truthfulness",
  faithfulness: "Faithfulness",
  cosine_sim: "Answer–gold cosine",
  squad_f1: "SQuAD F1",
  squad_em: "SQuAD EM",
};

function armMetric(arms: unknown, model: string, key: string): MetricValue | null {
  if (!isRecord(arms) || !isRecord(arms[model])) return null;
  const metrics = (arms[model] as Record<string, unknown>)["metrics"];
  return isRecord(metrics) ? metric(metrics[key]) : null;
}

function parsePairedRows(paired: unknown, arms: unknown): PairedMetricRow[] {
  if (!isRecord(paired) || !Array.isArray(paired["metrics"])) return [];
  const rows: PairedMetricRow[] = [];
  for (const raw of paired["metrics"]) {
    if (!isRecord(raw)) continue;
    const key = str(raw["metric"]);
    const diff = isRecord(raw["difference"]) ? metric(raw["difference"]["mean"]) : null;
    const pHolm = num(raw["p_holm"]);
    const pRaw = num(raw["p_raw"]);
    if (!key || !diff || pHolm === null || pRaw === null) continue;
    const w = isRecord(raw["wilcoxon"]) ? raw["wilcoxon"] : {};
    rows.push({
      metric: key,
      label: METRIC_LABELS[key] ?? key,
      note: str(raw["note"]) ?? "",
      llama: armMetric(arms, LLAMA, key),
      opus: armMetric(arms, OPUS, key),
      delta: diff,
      pRaw,
      pHolm,
      significant: raw["significant"] === true,
      wins: num(w["wins"]) ?? 0,
      losses: num(w["losses"]) ?? 0,
      ties: num(w["ties"]) ?? 0,
      nPairs: num(raw["n_pairs_used"]) ?? num(w["n_pairs"]) ?? 0,
      floorNote: str(raw["floor_note"]),
      method: str(w["method"]),
    });
  }
  return rows;
}

function parseLatency(arms: unknown): LatencySample[] | null {
  if (!isRecord(arms)) return null;
  const out: LatencySample[] = [];
  for (const [model, key] of [["llama", LLAMA], ["opus", OPUS]] as const) {
    const arm = arms[key];
    const lat = isRecord(arm) ? arm["latency_ms"] : null;
    if (!isRecord(lat)) continue;
    const retrieval = fiveNumber(lat["retrieval_ms"]);
    const generation = fiveNumber(lat["generation_ms"]);
    if (retrieval) out.push({ model, stage: "retrieval", stats: retrieval });
    if (generation) out.push({ model, stage: "generation", stats: generation });
  }
  return out.length > 0 ? out : null;
}

function parseCost(arms: unknown): CostRow[] | null {
  if (!isRecord(arms)) return null;
  const out: CostRow[] = [];
  for (const [key, label] of [
    [LLAMA, "Llama 3.1 8B (Ollama, local)"],
    [OPUS, "Claude Opus 4.8"],
  ] as const) {
    const arm = arms[key];
    const cost = isRecord(arm) ? arm["cost"] : null;
    if (!isRecord(cost)) continue;
    const costUSD = num(cost["total_usd"]);
    if (costUSD === null) continue;
    out.push({
      model: key,
      label,
      costUSD,
      inputTokens: num(cost["input_tokens"]) ?? 0,
      outputTokens: num(cost["output_tokens"]) ?? 0,
      nPricedRuns: num(cost["n_priced_runs"]) ?? 0,
    });
  }
  return out.length > 0 ? out : null;
}

/** The `subsets` array carries a `held_out` entry with its own win counts and
 *  per-arm means, but no paired test — the payload deliberately computes no
 *  p-value at n = 10. Rendered descriptively. */
function parseHeldOut(payload: Record<string, unknown>): PairedTable | null {
  if (!Array.isArray(payload["subsets"])) return null;
  const subset = payload["subsets"].find(
    (s) => isRecord(s) && s["label"] === "held_out",
  );
  if (!isRecord(subset) || !isRecord(subset["means"])) return null;
  const key = str(subset["metric"]) ?? "crag_score";
  const llama = metric(subset["means"][LLAMA]);
  const opus = metric(subset["means"][OPUS]);
  if (!llama || !opus) return null;
  const w = isRecord(subset["win_counts"]) ? subset["win_counts"] : {};
  const wins = isRecord(w["wins"]) ? w["wins"] : {};
  return {
    label: "Held-out questions",
    nQuestions: llama.n,
    rows: [
      {
        metric: key,
        label: METRIC_LABELS[key] ?? key,
        note: "Descriptive only — no paired test is computed at this sample size.",
        llama,
        opus,
        delta: { mean: opus.mean - llama.mean, ci: null, ciOmittedReason: "not computed for the held-out subset", n: llama.n },
        pRaw: Number.NaN,
        pHolm: Number.NaN,
        significant: false,
        wins: num(wins[OPUS]) ?? 0,
        losses: num(wins[LLAMA]) ?? 0,
        ties: num(w["ties"]) ?? 0,
        nPairs: num(w["n_pairs"]) ?? llama.n,
        floorNote: null,
        method: null,
      },
    ],
  };
}

function parseJudge(payload: unknown): JudgeValidation | null {
  if (!isRecord(payload)) return null;
  const jvh = payload["judge_vs_human"];
  const gate = payload["gate"];
  if (!isRecord(jvh) || !isRecord(gate)) return null;
  const kappa = num(jvh["kappa"]);
  const threshold = num(gate["threshold"]);
  if (kappa === null || threshold === null) return null;
  let kappaCI: [number, number] | null = null;
  if (isRecord(jvh["kappa_ci"])) {
    const low = num(jvh["kappa_ci"]["low"]);
    const high = num(jvh["kappa_ci"]["high"]);
    if (low !== null && high !== null) kappaCI = [low, high];
  }
  const rawCaveats = payload["caveats"];
  const caveats = Array.isArray(rawCaveats)
    ? rawCaveats.filter((c): c is string => typeof c === "string")
    : [];
  return {
    kappa,
    kappaCI,
    percentAgreement: num(jvh["percent_agreement"]),
    n: num(jvh["n"]) ?? 0,
    band: str(jvh["band"]) ?? "",
    threshold,
    passes: gate["passes"] === true,
    interpretation: str(gate["interpretation"]) ?? "",
    caveats,
  };
}

const EMPTY: DashboardData = {
  phase1: null, winner: null, bestVsRest: null, byStrategy: null, bySize: null,
  phase2: null, heldOut: null, latency: null, cost: null,
  costNote: null, tokenComparabilityNote: null, judge: null,
};

/**
 * Turns stored `analysis_results` rows into dashboard view models.
 *
 * Every slice is independently nullable: a payload that has not been computed,
 * or that fails to parse, empties its own sections and leaves the rest of the
 * page intact. Nothing here computes a statistic.
 */
export function parseAnalysis(rows: AnalysisRow[]): DashboardData {
  const by = new Map(rows.map((r) => [r.analysis, r.payload]));

  const ranking = parseConfigRanking(by.get("phase1_config_ranking"));
  const p2 = by.get("phase2_paired");
  const p2rec = isRecord(p2) ? p2 : null;
  const arms = p2rec?.["arms"];
  const pairedRows = p2rec ? parsePairedRows(p2rec["paired"], arms) : [];

  return {
    ...EMPTY,
    phase1: ranking?.rows ?? null,
    winner: ranking?.winner ?? null,
    bestVsRest: parseBestVsRest(by.get("phase1_best_vs_rest")),
    byStrategy: parseFactor(by.get("phase1_factor_strategy")),
    bySize: parseFactor(by.get("phase1_factor_size")),
    phase2:
      pairedRows.length > 0
        ? {
            label: "All questions",
            nQuestions: num(p2rec?.["n_questions"]) ?? pairedRows[0]!.nPairs,
            rows: pairedRows,
          }
        : null,
    heldOut: p2rec ? parseHeldOut(p2rec) : null,
    latency: parseLatency(arms),
    cost: parseCost(arms),
    costNote: p2rec ? str(p2rec["cost_note"]) : null,
    tokenComparabilityNote: p2rec ? str(p2rec["token_comparability_note"]) : null,
    judge: parseJudge(by.get("judge_validation")),
  };
}
