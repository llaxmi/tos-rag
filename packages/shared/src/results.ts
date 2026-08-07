/**
 * View models for the results dashboard, parsed from `analysis_results`.
 *
 * Every field here corresponds to something the Python analysis step stored.
 * Nothing in this module computes a statistic — a number that is not in a
 * payload does not appear on the dashboard (PRD §12).
 */

import { CHUNK_SIZES, MODEL_IDS, PHASE1_WINNER, STRATEGIES } from "@tos-rag/core";

import type { AnalysisRow } from "./types";
import { MODEL_LABELS } from "./types";

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
  /** How the p-value was obtained. `stats.py`'s `paired_wilcoxon` reports one
   *  of three literal strings: `"permutation (exhaustive)"`,
   *  `"permutation (monte carlo, seeded)"`, or (when every paired difference
   *  is zero, so there are no signed ranks to permute and no test runs at
   *  all) `"degenerate (all differences zero)"` with `p = 1.0` by
   *  convention. Read verbatim from `wilcoxon.method`; scipy never returns
   *  `"exact"` for this metric family (see `_permutation_method`'s
   *  docstring), so that word must never be assumed. */
  method: string | null;
}

/** The literal `method` string `stats.py` reports when a pair set has no
 *  discordant differences: no permutation test ran, `p = 1.0` is a
 *  convention, not a computed result. Presentation code must not fold this
 *  into a "via {method}" sentence — that would claim a method was used when
 *  none was. */
export const NO_TEST_METHOD = "degenerate (all differences zero)";

export interface PairedTable {
  label: string;
  nQuestions: number;
  rows: PairedMetricRow[];
}

/** Describes how a paired table's p-values were computed, for the §4 lead
 *  sentence. Names the method only when every row that ran a test used the
 *  *same* real method — a table can legitimately mix methods (rows differ in
 *  `n_pairs_used` once NULLs are pairwise-deleted, e.g. `faithfulness`
 *  dropping abstentions, so one row can cross the exhaustive/Monte-Carlo
 *  boundary while others don't; a row can also land in the degenerate
 *  no-test case while others don't), and a single sentence cannot state a
 *  mixed table's methods without naming one that is not universally true.
 *  Returns null in that case — the caller should show per-row methods (e.g.
 *  a table tooltip) instead of asserting one in prose. */
export function wilcoxonMethodPhrase(table: PairedTable | null): string | null {
  if (!table) return null;
  const methods = new Set(
    table.rows.map((r) => r.method).filter((m): m is string => m !== null),
  );
  // A null method on any row means that row never reported a method — it is
  // unconfirmed, not an implicit agreement with the rows that did report
  // one. Excluding nulls from the set before checking size would treat that
  // row as if it matched, which is the same class of false claim finding 2
  // targeted, just one row lighter.
  if (methods.size !== 1 || !table.rows.every((r) => r.method !== null)) return null;
  const [method] = methods;
  if (method === NO_TEST_METHOD) return null;
  return `via ${method}`;
}

export interface CostRow {
  model: string;
  /** Model display name, and the parenthetical qualifier the view renders in
   *  muted ink beside it — kept as two fields so the view never re-parses a
   *  composed string. */
  name: string;
  note: string | null;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  nPricedRuns: number;
}

/** One arm's bill divided by the answers it got right, plus the raw counts the
 *  ratio is built from — a reader has to be able to see that $0.02 per correct
 *  answer is 29 of 30, not 1 of 1. */
export interface CostPerCorrect {
  model: string;
  name: string;
  nCorrect: number;
  nRuns: number;
  costUSD: number;
  /** Null only when the arm got nothing right; 0 is a real value for a free arm. */
  usdPerCorrect: number | null;
}

/** The paid arm's bill split into the half fixed by retrieval (input) and the
 *  half the generator controls (output). */
export interface CostSplit {
  model: string;
  name: string;
  inputUSD: number;
  outputUSD: number;
  /** Null for a $0 arm — a free bill has no meaningful split. */
  inputShare: number | null;
}

/** Per-question outcomes, grouped by which arms answered correctly. */
export interface CostBucket {
  bucket: string;
  label: string;
  nQuestions: number;
  llamaOutputTokens: number | null;
  opusOutputTokens: number | null;
  opusCostUSD: number | null;
}

export interface CostEffectiveness {
  perCorrect: CostPerCorrect[];
  /** Opus minus Llama. Negative or zero means the paid arm bought no accuracy. */
  additionalCorrect: number;
  additionalUSD: number;
  /** Null when `additionalCorrect <= 0` — the payload declines to divide, and so
   *  does the view, rather than rendering an infinite or negative unit price. */
  usdPerAdditionalCorrect: number | null;
  split: CostSplit | null;
  buckets: CostBucket[];
  inputShareNote: string | null;
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
  costEffectiveness: CostEffectiveness | null;
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

// The arm keys the payloads are keyed by. Taken from core rather than retyped:
// a drift here yields null arms and silently blank §4–§6 rather than an error.
const LLAMA = MODEL_IDS.llama;
const OPUS = MODEL_IDS.opus;

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
  for (const [key, name, note] of [
    [LLAMA, MODEL_LABELS.llama, "(Ollama, local)"],
    [OPUS, MODEL_LABELS.opus, null],
  ] as const) {
    const arm = arms[key];
    const cost = isRecord(arm) ? arm["cost"] : null;
    if (!isRecord(cost)) continue;
    const costUSD = num(cost["total_usd"]);
    if (costUSD === null) continue;
    out.push({
      model: key,
      name,
      note,
      costUSD,
      inputTokens: num(cost["input_tokens"]) ?? 0,
      outputTokens: num(cost["output_tokens"]) ?? 0,
      nPricedRuns: num(cost["n_priced_runs"]) ?? 0,
    });
  }
  return out.length > 0 ? out : null;
}

/** Bucket labels. The payload names buckets by role (`treatment_only`); the
 *  dashboard names them by model, because a reader looking at the table has no
 *  reason to know which arm is the treatment. */
const BUCKET_LABELS: Record<string, string> = {
  both_correct: "Both correct",
  treatment_only: `${MODEL_LABELS.opus} only`,
  baseline_only: `${MODEL_LABELS.llama} only`,
  neither: "Neither correct",
};

function parseCostBuckets(raw: unknown): CostBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: CostBucket[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const bucket = str(entry["bucket"]);
    const nQuestions = num(entry["n_questions"]);
    if (bucket === null || nQuestions === null) continue;
    const llama = isRecord(entry[LLAMA]) ? entry[LLAMA] : {};
    const opus = isRecord(entry[OPUS]) ? entry[OPUS] : {};
    out.push({
      bucket,
      label: BUCKET_LABELS[bucket] ?? bucket,
      nQuestions,
      // Left null rather than defaulted to 0: an empty bucket has no mean answer
      // length, and 0 would read as "the model answered with nothing".
      llamaOutputTokens: num(llama["mean_output_tokens"]),
      opusOutputTokens: num(opus["mean_output_tokens"]),
      opusCostUSD: num(opus["mean_usd_per_run"]),
    });
  }
  return out;
}

/** Reads the `cost_effectiveness` payload — cost expressed against quality.
 *
 *  Nothing here divides: every ratio is read from the payload, which already
 *  decided when a ratio is undefined (no correct answers, no additional correct
 *  answers, a $0 bill with no meaningful input share). Recomputing them in the
 *  view could disagree with the report, which cites the stored numbers. */
function parseCostEffectiveness(raw: unknown): CostEffectiveness | null {
  if (!isRecord(raw)) return null;
  const arms = raw["arms"];
  if (!isRecord(arms)) return null;

  const perCorrect: CostPerCorrect[] = [];
  let split: CostSplit | null = null;
  for (const [key, name] of [
    [LLAMA, MODEL_LABELS.llama],
    [OPUS, MODEL_LABELS.opus],
  ] as const) {
    const arm = arms[key];
    if (!isRecord(arm)) continue;
    const costUSD = num(arm["total_usd"]);
    const nCorrect = num(arm["n_correct"]);
    const nRuns = num(arm["n_runs"]);
    if (costUSD === null || nCorrect === null || nRuns === null) continue;
    perCorrect.push({
      model: key,
      name,
      nCorrect,
      nRuns,
      costUSD,
      usdPerCorrect: num(arm["usd_per_correct_answer"]),
    });
    // Only a priced arm gets a split; a $0 bill has nothing to divide.
    const inputUSD = num(arm["input_usd"]);
    const outputUSD = num(arm["output_usd"]);
    const inputShare = num(arm["input_share"]);
    if (inputUSD !== null && outputUSD !== null && inputShare !== null) {
      split = { model: key, name, inputUSD, outputUSD, inputShare };
    }
  }
  if (perCorrect.length === 0) return null;

  const marginal = isRecord(raw["marginal"]) ? raw["marginal"] : {};
  return {
    perCorrect,
    additionalCorrect: num(marginal["additional_correct_answers"]) ?? 0,
    additionalUSD: num(marginal["additional_usd"]) ?? 0,
    usdPerAdditionalCorrect: num(marginal["usd_per_additional_correct_answer"]),
    split,
    buckets: parseCostBuckets(raw["outcome_buckets"]),
    inputShareNote: str(raw["input_share_note"]),
  };
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
  phase2: null, heldOut: null, latency: null, cost: null, costEffectiveness: null,
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
    costEffectiveness: p2rec ? parseCostEffectiveness(p2rec["cost_effectiveness"]) : null,
    costNote: p2rec ? str(p2rec["cost_note"]) : null,
    tokenComparabilityNote: p2rec ? str(p2rec["token_comparability_note"]) : null,
    judge: parseJudge(by.get("judge_validation")),
  };
}
