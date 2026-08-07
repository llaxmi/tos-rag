# Dashboard Live Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every number on the results dashboard come from `analysis_results` in Postgres, and delete the invented sample data that currently feeds it.

**Architecture:** A pure `parseAnalysis(rows)` function in `packages/shared` turns the six stored payloads into typed view models; `DashboardView` renders those and computes nothing. Each payload key is independently nullable, so a missing key empties only its own sections. `packages/shared/src/sample.ts` is deleted, and the prop types it happened to own move to a new `results.ts`.

**Tech Stack:** TypeScript, React 19, Vitest (in `packages/shared`), Python 3.12 + uv + pytest (in `analysis/`), Postgres via Prisma.

**Spec:** `docs/superpowers/specs/2026-08-07-dashboard-live-data-design.md`

## Global Constraints

- **The dashboard computes nothing.** No means, no averaging, no confidence intervals, no percentages derived from other numbers. Formatting only. If a number is needed and not stored, it is a payload change (Task 1), not a client-side calculation.
- **Never invent a confidence interval.** Where the payload has `ci: null`, render an em-dash and surface the stored `ci_omitted_reason`. The `mean ± 0.07` pattern at `DashboardView.tsx:156` is the exact bug being removed.
- **Never coerce NULL to a number.** A missing metric renders as `—`, never `0.00`. (0 is a real CRAG score meaning abstention.)
- **No hardcoded experimental numbers in JSX copy.** Any sentence that states a number must interpolate it from parsed data or be rewritten without it. This is what stops the prose drifting from the data again.
- **Packages are source-only.** No `dist`, no deep imports; extend `src/index.ts` barrels.
- Every metric key in payloads is snake_case (`crag_score`, `char_recall`, `hit_at_8`); every TypeScript field is camelCase. The parser is the only place the two vocabularies meet.
- `hit_at_8` / `char_*@8` are legacy column names — k = 5 (PRD §15 #11). UI labels say `@5`.
- Run `pnpm typecheck` from the repo root as the gate on every task that touches TypeScript.
- The local Postgres needs only `docker start supabase_db_tos-rag`, not the full Supabase stack.
- Honour the repo's git workflow: branch `feature/<issue-number>` off `main`, and **do not commit or push without explicit user approval**, notwithstanding the `git commit` steps written below.

---

### Task 1: Five-number latency summaries in the Python payloads

`LatencyBoxes` draws a box plot, which needs quartiles. `phase2.py` currently stores only `{n, median, p95}`, and `phase1.py` stores latency as a plain mean+CI estimate with no distribution shape at all.

**Files:**
- Modify: `analysis/src/tosrag_analysis/phase2.py` (the latency summary builder)
- Modify: `analysis/src/tosrag_analysis/phase1.py` (add a latency summary per config)
- Test: `analysis/tests/test_phase2.py`, `analysis/tests/test_phase1.py`

**Interfaces:**
- Consumes: nothing.
- Produces: a `latency_ms` block whose per-stage value is
  `{"n": int, "min": float, "q1": float, "median": float, "q3": float, "max": float, "p95": float}`
  under `phase2_paired.arms[<model>].latency_ms.{retrieval_ms,generation_ms}` and
  `phase1_config_ranking.configs[].latency_ms.{retrieval_ms,generation_ms}`.

- [ ] **Step 1: Find the existing latency summary builder**

Run: `grep -n "p95\|latency_ms\|median" analysis/src/tosrag_analysis/phase2.py`

Read the function it points at. It currently returns `{"n": ..., "median": ..., "p95": ...}`. Note its name and its input type (a sequence of per-run millisecond values) before editing.

- [ ] **Step 2: Write the failing test for the five-number summary**

Add to `analysis/tests/test_phase2.py`. Replace `_summarise_latency` with the actual function name found in Step 1:

```python
def test_latency_summary_reports_five_number_summary():
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    got = phase2._summarise_latency(values)
    assert got["n"] == 5
    assert got["min"] == 10.0
    assert got["q1"] == 20.0
    assert got["median"] == 30.0
    assert got["q3"] == 40.0
    assert got["max"] == 50.0


def test_latency_summary_is_ordered():
    got = phase2._summarise_latency([50.0, 10.0, 30.0, 20.0, 40.0])
    assert got["min"] <= got["q1"] <= got["median"] <= got["q3"] <= got["max"]


def test_latency_summary_handles_single_run():
    got = phase2._summarise_latency([42.0])
    assert got["n"] == 1
    assert got["min"] == got["q1"] == got["median"] == got["q3"] == got["max"] == 42.0
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd analysis && uv run pytest tests/test_phase2.py -k latency_summary -v`
Expected: FAIL with `KeyError: 'q1'`.

- [ ] **Step 4: Add the quartiles**

In the summary builder, keep the existing `median` and `p95` keys and add the rest. Use the same percentile convention the rest of the module uses — check whether it calls `statistics.quantiles` or `numpy.percentile` and match it, so the median stays byte-identical to the currently stored value:

```python
def _summarise_latency(values: Sequence[float]) -> dict[str, float | int]:
    ordered = sorted(float(v) for v in values)
    return {
        "n": len(ordered),
        "min": ordered[0],
        "q1": _percentile(ordered, 25),
        "median": _percentile(ordered, 50),
        "q3": _percentile(ordered, 75),
        "max": ordered[-1],
        "p95": _percentile(ordered, 95),
    }
```

If the module has no `_percentile` helper, reuse whatever it already uses for `p95` rather than introducing a second convention — a median computed two ways in one file is a latent bug.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd analysis && uv run pytest tests/test_phase2.py -k latency_summary -v`
Expected: PASS.

- [ ] **Step 6: Add the same summary to Phase 1, per config**

`phase1_config_ranking.configs[]` has `retrieval_ms` and `generation_ms` as mean+CI estimates. Add a sibling `latency_ms` block built with the same helper so §5 can show per-config distributions. Import the helper from `phase2` rather than copying it — one implementation, one convention.

Write the failing test first, in `analysis/tests/test_phase1.py`:

```python
def test_config_ranking_carries_latency_quartiles():
    payload = phase1.build_config_ranking(SMALL_ROWS)
    first = payload["configs"][0]
    assert set(first["latency_ms"]) == {"retrieval_ms", "generation_ms"}
    assert set(first["latency_ms"]["generation_ms"]) == {
        "n", "min", "q1", "median", "q3", "max", "p95",
    }
```

Replace `SMALL_ROWS` and `build_config_ranking` with the fixture and builder names already used in that test file.

- [ ] **Step 7: Run the whole Python suite**

Run: `cd analysis && uv run pytest`
Expected: PASS, 141 + the new tests. If any existing test asserts the exact keys of the latency block, update it — that assertion is now describing the old shape.

- [ ] **Step 8: Re-run the analysis against the real database**

```bash
docker start supabase_db_tos-rag
pnpm analyze --dry-run    # inspect first; writes nothing
pnpm analyze              # writes; idempotent, seed 42
```

Verify the new keys landed:

```bash
docker exec supabase_db_tos-rag psql -U postgres -d postgres -t -A -c \
  "select jsonb_pretty(payload->'arms'->'claude-opus-4-8'->'latency_ms') from analysis_results where analysis='phase2_paired';"
```

Expected: an object with `min`, `q1`, `median`, `q3`, `max`, `p95` under both stages. Confirm `median` is unchanged from before the edit (Opus generation median was `6792.5` for Llama; check the value you recorded pre-change).

- [ ] **Step 9: Commit** (only with user approval — see Global Constraints)

```bash
git add analysis/src/tosrag_analysis/phase1.py analysis/src/tosrag_analysis/phase2.py analysis/tests/test_phase1.py analysis/tests/test_phase2.py
git commit -m "analysis: store five-number latency summaries for the dashboard box plots"
```

---

### Task 2: `results.ts` — view-model types and the `parseAnalysis` reader

The parser lives in `packages/shared`, not the frontend, because `apps/frontend` has **no test runner configured** (no vitest in its `package.json`) while `packages/shared` already runs `vitest run` over `packages/shared/test/`. Shared also already owns the API contract types, which is what these are.

This task adds files only. Nothing imports them yet, and `sample.ts` still exists, so the build stays green throughout.

**Files:**
- Create: `packages/shared/src/results.ts`
- Create: `packages/shared/test/results.test.ts`
- Create: `packages/shared/test/fixtures/analysis-results.json`

**Interfaces:**
- Consumes: `AnalysisRow` from `packages/shared/src/types.ts` — `{ analysis: string; payload: unknown }`.
- Produces:
  - `parseAnalysis(rows: AnalysisRow[]): DashboardData`
  - types `MetricValue`, `FiveNumber`, `ConfigRow`, `FactorLevel`, `PairedMetricRow`, `PairedTable`, `CostRow`, `LatencySample`, `JudgeValidation`, `DashboardData`

- [ ] **Step 1: Capture a fixture from the real database**

```bash
docker start supabase_db_tos-rag
docker exec supabase_db_tos-rag psql -U postgres -d postgres -t -A -c \
  "select jsonb_pretty(jsonb_agg(jsonb_build_object('analysis', analysis, 'payload', payload))) from analysis_results;" \
  > packages/shared/test/fixtures/analysis-results.json
```

Open the file and confirm it is a JSON array of 6 objects, each `{analysis, payload}`, and that it starts with `[` (strip any leading blank line psql emits). This fixture is the contract: if the Python side changes a payload shape, this test is what catches it.

- [ ] **Step 2: Write the types**

Create `packages/shared/src/results.ts`:

```ts
/**
 * View models for the results dashboard, parsed from `analysis_results`.
 *
 * Every field here corresponds to something the Python analysis step stored.
 * Nothing in this module computes a statistic — a number that is not in a
 * payload does not appear on the dashboard (PRD §12).
 */

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
  percentAgreement: number;
  n: number;
  band: string;
  threshold: number;
  passes: boolean;
  interpretation: string;
}

export interface DashboardData {
  phase1: ConfigRow[] | null;
  winner: string | null;
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
```

- [ ] **Step 3: Write the failing tests**

Create `packages/shared/test/results.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAnalysis } from "../src/results";
import type { AnalysisRow } from "../src/types";
import fixture from "./fixtures/analysis-results.json";

const ROWS = fixture as AnalysisRow[];

describe("parseAnalysis", () => {
  it("reads all 15 Phase-1 configurations in rank order", () => {
    const d = parseAnalysis(ROWS);
    expect(d.phase1).toHaveLength(15);
    expect(d.phase1![0]!.rank).toBe(1);
    expect(d.phase1![0]!.strategy).toBe("sentence");
    expect(d.phase1![0]!.chunkSize).toBe(512);
    expect(d.winner).toBe("sentence:512");
  });

  it("preserves a null CI instead of inventing one", () => {
    const d = parseAnalysis(ROWS);
    const top = d.phase1![0]!;
    expect(top.hitRate!.ci).toBeNull();
    expect(top.hitRate!.ciOmittedReason).toBe("zero variance in sample");
  });

  it("keeps each metric's own n, because retrieval metrics skip unanswerables", () => {
    const d = parseAnalysis(ROWS);
    const top = d.phase1![0]!;
    expect(top.truthfulness.n).toBe(20);
    expect(top.charRecall!.n).toBe(16);
  });

  it("reads the factor breakdowns rather than averaging config rows", () => {
    const d = parseAnalysis(ROWS);
    expect(d.bySize!.map((l) => l.label)).toEqual(
      expect.arrayContaining(["128", "256", "512"]),
    );
    const size256 = d.bySize!.find((l) => l.label === "256")!;
    expect(size256.estimate.mean).toBeCloseTo(0.77, 5);
    expect(size256.estimate.ci).not.toBeNull();
  });

  it("reads the Phase-2 paired table with its win counts and Holm p-values", () => {
    const d = parseAnalysis(ROWS);
    const crag = d.phase2!.rows.find((r) => r.metric === "crag_score")!;
    expect(crag.llama!.mean).toBeCloseTo(0.6, 5);
    expect(crag.opus!.mean).toBeCloseTo(0.9333, 3);
    expect(crag.wins).toBe(5);
    expect(crag.losses).toBe(0);
    expect(crag.ties).toBe(25);
    expect(crag.significant).toBe(false);
    expect(crag.floorNote).toContain("discordant");
  });

  it("reads latency as stored five-number summaries", () => {
    const d = parseAnalysis(ROWS);
    const gen = d.latency!.find(
      (s) => s.model === "opus" && s.stage === "generation",
    )!;
    expect(gen.stats.q1).toBeLessThanOrEqual(gen.stats.median);
    expect(gen.stats.median).toBeLessThanOrEqual(gen.stats.q3);
  });

  it("reads the judge validation gate", () => {
    const d = parseAnalysis(ROWS);
    expect(d.judge!.kappa).toBeCloseTo(0.92, 3);
    expect(d.judge!.threshold).toBe(0.61);
    expect(d.judge!.passes).toBe(true);
  });

  it("returns nulls for every slice when given no rows", () => {
    const d = parseAnalysis([]);
    expect(d.phase1).toBeNull();
    expect(d.phase2).toBeNull();
    expect(d.judge).toBeNull();
    expect(d.latency).toBeNull();
  });

  it("nulls only the missing slice when one key is absent", () => {
    const d = parseAnalysis(ROWS.filter((r) => r.analysis !== "phase2_paired"));
    expect(d.phase1).not.toBeNull();
    expect(d.phase2).toBeNull();
    expect(d.latency).toBeNull();
    expect(d.cost).toBeNull();
  });

  it("survives a malformed payload without throwing", () => {
    const d = parseAnalysis([{ analysis: "phase1_config_ranking", payload: 42 }]);
    expect(d.phase1).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @tos-rag/shared exec vitest run test/results.test.ts`
Expected: FAIL — `parseAnalysis` is not exported from `../src/results`.

If instead it fails on `Cannot find module './fixtures/analysis-results.json'`, add `"resolveJsonModule": true` to `packages/shared/tsconfig.json`'s `compilerOptions`.

- [ ] **Step 5: Implement the parser**

Append to `packages/shared/src/results.ts`. The shape is: small total helpers that return `null` rather than throwing, so one malformed payload cannot blank the whole page.

```ts
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
```

Then the Phase-2 half. The payload nests per-arm means under `arms[model].metrics[metric]` (which carry the CIs) while the paired test lives under `paired.metrics[]`, so the two are joined by metric name:

```ts
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
      },
    ],
  };
}
```

Note the one deliberate exception to "compute nothing": the held-out delta is `opus.mean - llama.mean`, because the payload stores the two means but no difference for this subset. It is a subtraction of two displayed numbers, not a statistic, and its `ci` is explicitly null. Do not extend this to anything else.

Then the judge block and the entry point:

```ts
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
  return {
    kappa,
    kappaCI,
    percentAgreement: num(jvh["percent_agreement"]) ?? 0,
    n: num(jvh["n"]) ?? 0,
    band: str(jvh["band"]) ?? "",
    threshold,
    passes: gate["passes"] === true,
    interpretation: str(gate["interpretation"]) ?? "",
  };
}

const EMPTY: DashboardData = {
  phase1: null, winner: null, byStrategy: null, bySize: null,
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @tos-rag/shared exec vitest run test/results.test.ts`
Expected: PASS, 10 tests.

If `bySize` labels come back as `"128"` vs `128`, check the payload — `level` is a JSON number for the size factor and a string for the strategy factor. The `str(...) ?? String(...)` fallback in `parseFactor` handles it; if a test still fails, that is the line to look at.

- [ ] **Step 7: Leave the barrel alone**

Do **not** add `export * from "./results"` to `packages/shared/src/index.ts` in this task. `sample.ts` still exports a type named `ConfigRow`, so exporting both from the barrel is a duplicate-export error. The barrel swap is the first step of Task 3, where `sample.ts` is deleted in the same breath.

The test file imports `../src/results` directly, so it compiles and runs without the barrel.

- [ ] **Step 8: Verify the rest of the repo is untouched**

Run: `pnpm typecheck`
Expected: PASS. Nothing imports `results.ts` yet.

- [ ] **Step 9: Commit** (only with user approval)

```bash
git add packages/shared/src/results.ts packages/shared/test/results.test.ts packages/shared/test/fixtures/analysis-results.json
git commit -m "shared: add parseAnalysis reader over stored analysis_results payloads"
```

---

### Task 3: The flip — delete the sample data and render live

This is the atomic switchover. `sample.ts` disappears, the UI components move to the new prop shapes, and `DashboardView` renders parsed data with per-section empty states. It is one task because `pnpm typecheck` cannot pass in the middle of it.

**Files:**
- Delete: `packages/shared/src/sample.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/ui/src/viz/Heatmap.tsx` (5 references to `r.truthfulness`)
- Modify: `packages/ui/src/viz/LatencyBoxes.tsx`, `packages/ui/src/viz/LatencyStacks.tsx`
- Modify: `apps/frontend/src/views/DashboardView.tsx`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: a `DashboardView` whose only data source is `parseAnalysis(await getResults())`.

- [ ] **Step 1: Swap the barrel exports**

In `packages/shared/src/index.ts`, replace `export * from "./sample";` with `export * from "./results";`, then delete the file:

```bash
git rm packages/shared/src/sample.ts
```

`sample.ts` also re-exported `STRATEGIES`, `PHASE1_WINNER` and `SIZES` (aliasing `CHUNK_SIZES`) from `@tos-rag/core`. Move those three re-exports verbatim into `results.ts` so importers keep working:

```ts
import { CHUNK_SIZES, PHASE1_WINNER, STRATEGIES } from "@tos-rag/core";
export { STRATEGIES, PHASE1_WINNER };
export const SIZES = CHUNK_SIZES;
```

- [ ] **Step 2: Run typecheck to see the full breakage**

Run: `pnpm typecheck`
Expected: FAIL, with errors in `Heatmap.tsx`, `LatencyBoxes.tsx`, `LatencyStacks.tsx` and `DashboardView.tsx`. This error list is your worklist for the rest of the task.

- [ ] **Step 3: Update `Heatmap.tsx`**

`ConfigRow.truthfulness` is now a `MetricValue`. Change every `r.truthfulness` to `r.truthfulness.mean` — there are five: `extent()` (line ~17), and the `heatColor(...)` / `.toFixed(2)` calls at roughly lines 80, 103, 126, 211. `ContactSheet` lives in the same file and needs the same treatment.

Add the CI to the heatmap cell's `<title>` tooltip while here, since it is now available:

```tsx
<title>
  {r.strategy} × {r.chunkSize}: {r.truthfulness.mean.toFixed(2)}
  {r.truthfulness.ci
    ? ` (95% CI ${r.truthfulness.ci[0].toFixed(2)}–${r.truthfulness.ci[1].toFixed(2)})`
    : ` (no CI — ${r.truthfulness.ciOmittedReason ?? "not computed"})`}
</title>
```

- [ ] **Step 4: Update the latency components**

Both call `boxStats(s.values)`. `LatencySample` now carries `stats` directly, so delete the `boxStats` import and the call:

In `LatencyBoxes.tsx`, replace `const st = boxStats(s.values);` with `const st = s.stats;`, and replace the axis domain line

```ts
const maxX = Math.max(...samples.flatMap((s) => s.values)) * 1.06;
```

with

```ts
const maxX = Math.max(...samples.map((s) => s.stats.max)) * 1.06;
```

In `LatencyStacks.tsx`, replace the two `boxStats(...).median` lookups with `.stats.median`, and make the lookup total rather than `!`-asserted, since an arm can be missing:

```ts
const stageMedian = (model: string, stage: string): number =>
  samples.find((s) => s.model === model && s.stage === stage)?.stats.median ?? 0;

const rows: ModelTotals[] = models.map((model) => ({
  model,
  retrievalMs: stageMedian(model, "retrieval"),
  generationMs: stageMedian(model, "generation"),
}));
```

Leave `boxStats` in `packages/shared/src/scale.ts` — it is still covered by `helpers.test.ts` and removing it is out of scope.

- [ ] **Step 5: Add an empty-state component to `DashboardView.tsx`**

```tsx
/** Shown in place of a figure whose payload has not been computed. The
 *  dashboard states the absence rather than filling it with a plausible
 *  number — the same rule the report follows for unmeasured values. */
function NoData({ what }: { what: string }) {
  return (
    <Card className="border-dashed p-8">
      <p className="text-muted-foreground text-[13.5px]">
        No {what} in the database yet. Run <code className="font-mono">pnpm analyze</code>{" "}
        to compute it.
      </p>
    </Card>
  );
}
```

- [ ] **Step 6: Replace the data plumbing at the top of the component**

Delete the `live` state, the `rows = SAMPLE_PHASE1` line, and both fabricated-CI blocks (`byStrategy` / `bySize` at lines ~150–169). Replace with:

```tsx
const [data, setData] = useState<DashboardData | null>(null);
const [loadFailed, setLoadFailed] = useState(false);

useEffect(() => {
  getResults()
    .then((rows) => setData(parseAnalysis(rows ?? [])))
    .catch(() => setLoadFailed(true));
}, []);

const rows = data?.phase1 ?? null;

const toBars = (levels: FactorLevel[] | null, suffix = ""): FactorBar[] | null =>
  levels?.map((l) => ({
    label: `${l.label}${suffix}`,
    value: l.estimate.mean,
    // FactorBars requires an interval; where the analysis omitted one, the
    // whisker collapses to the point estimate rather than being invented.
    ci: l.estimate.ci ?? [l.estimate.mean, l.estimate.mean],
  })) ?? null;

const byStrategy = toBars(data?.byStrategy ?? null);
const bySize = toBars(data?.bySize ?? null, " tok");
```

Import `parseAnalysis`, `type DashboardData`, `type FactorLevel` from `@tos-rag/shared` and `type FactorBar` from `@tos-rag/ui`.

Replace the `live === false` alert with a load-failure alert:

```tsx
{loadFailed && (
  <Alert variant="destructive" className="mb-8 border-dashed">
    <AlertTitle className="font-mono text-[11px] uppercase tracking-[0.14em]">
      Results unavailable
    </AlertTitle>
    <AlertDescription>
      Couldn't reach the results API. Check that the backend is running.
    </AlertDescription>
  </Alert>
)}
```

- [ ] **Step 7: Guard each section on its own slice**

Every section body becomes `{x ? <figure/> : <NoData what="…"/>}`. The header's `<ContactSheet rows={rows} />` needs the same guard. §1's table body maps `rows`, §2 needs `rows`, §3 needs `byStrategy`/`bySize`, §4 needs `data?.phase2`, §5 needs `data?.latency`, §6 needs `data?.cost`.

Drop the hardcoded `domainMax={0.7}` from both `FactorBars` — real factor means reach 0.83 and would clip. Let the component derive its domain from the CI upper bounds.

Change the heatmap highlight from the hardcoded `{strategy: "recursive", chunkSize: 256}` to the actual winner:

```tsx
<Heatmap rows={rows} highlight={PHASE1_WINNER} />
```

- [ ] **Step 8: Rewrite §1's metric cells for `MetricValue`**

`METRIC_COLUMNS` keys change to the new field names, and the `@8` labels become `@5`:

```tsx
const METRIC_COLUMNS: Array<{ key: keyof ConfigMetrics; label: string }> = [
  { key: "truthfulness", label: "Truthfulness" },
  { key: "faithfulness", label: "Faithfulness" },
  { key: "charRecall", label: "Char R@5" },
  { key: "charPrecision", label: "Char P@5" },
  { key: "hitRate", label: "Hit@5" },
  { key: "squadF1", label: "SQuAD F1" },
];
```

The cell renderer handles null metrics and null CIs:

```tsx
{METRIC_COLUMNS.map((c) => {
  const m = r[c.key];
  return (
    <TableCell key={c.key} className={cn(NUM_CELL, isWinner && "font-bold")}>
      {m === null ? (
        <span className="text-muted-foreground">—</span>
      ) : c.key === "truthfulness" && m.ci ? (
        formatMeanCI(m.mean, m.ci)
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>{m.mean.toFixed(2)}</span>
          </TooltipTrigger>
          <TooltipContent>
            {m.ci
              ? `95% CI ${m.ci[0].toFixed(2)}–${m.ci[1].toFixed(2)} (n = ${m.n})`
              : `No CI — ${m.ciOmittedReason ?? "not computed"} (n = ${m.n})`}
          </TooltipContent>
        </Tooltip>
      )}
    </TableCell>
  );
})}
```

Delete the now-unused `Numeric` type at line 44.

- [ ] **Step 9: Rewrite §4 for the parsed paired table**

Replace `SAMPLE_PHASE2.map(...)` with `data.phase2.rows.map(...)`. The `maxDelta` line moves inside the guard:

```tsx
const maxDelta = Math.max(...table.rows.map((m) => Math.abs(m.delta.mean)), 1e-9);
```

`m.llamaMean` → `m.llama?.mean`, `m.llamaCI` → `m.llama?.ci`, `m.delta` → `m.delta.mean`, `m.pHolm` stays. `MeanCI` gains null tolerance:

```tsx
function MeanCI({ value, strong }: { value: MetricValue | null; strong?: boolean }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="leading-tight">
      <div className={cn(strong && "text-foreground font-medium")}>
        {value.mean.toFixed(2)}
      </div>
      <div className="text-muted-foreground text-[12px]">
        {value.ci
          ? `${value.ci[0].toFixed(2)}–${value.ci[1].toFixed(2)}`
          : (value.ciOmittedReason ?? "no CI")}
      </div>
    </div>
  );
}
```

Add a win-count column — the PRD asks for per-question win counts and the payload has them:

```tsx
<TableCell className={NUM_CELL_LG}>
  <span className="font-mono">{m.wins}–{m.losses}–{m.ties}</span>
</TableCell>
```

with header `W–L–T` and a tooltip reading `Opus wins – Llama wins – ties, over ${m.nPairs} paired questions`.

- [ ] **Step 10: Rewrite §5 and §6 for parsed data**

§5: `<LatencyStacks samples={data.latency} />`, plus `<LatencyBoxes samples={data.latency} />` — the box plots are the PRD §12.5 figure and now have the quartiles they need. Keep the stacks as the median summary above them.

§6: `data.cost.map(...)`, using `r.label` instead of `r.model` for display. Two changes matter:

- The local arm's `costUSD` is genuinely `0`, so `maxCost` scaling gives it a zero-width bar. Render `$0.00` with `data.costNote` beside it rather than a bar, since "no marginal API cost" is not the same as "cheap".
- Render `data.tokenComparabilityNote` under the token counts. Each model counts tokens with its own tokenizer, so the input figures are **not** comparable across arms even though the prompt is byte-identical.

- [ ] **Step 11: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors.

- [ ] **Step 12: Run the full test suite**

Run: `pnpm test`
Expected: PASS. If a test imported `SAMPLE_*`, replace the import with a small inline literal in that test rather than reviving the module.

- [ ] **Step 13: Verify against the real database in a browser**

```bash
docker start supabase_db_tos-rag
pnpm dev
```

Open `http://localhost:5173/#/results` and confirm, section by section:

| Check | Expected |
|---|---|
| §1 top row | `sentence × 512 ← winner`, Truthfulness `0.90` |
| §1 bottom row | `fixed × 128`, Truthfulness `0.50` |
| §1 `Hit@5` on the top row | `1.00`, tooltip says no CI, zero variance |
| §2 highlight ring | on `sentence × 512`, **not** `recursive × 256` |
| §3 bars | `256` tallest at 0.77; no bar clipped at the right edge |
| §4 Truthfulness row | Llama `0.60`, Opus `0.93`, p (Holm) `0.247`, W–L–T `5–0–25` |
| §4 significance | nothing highlighted — no metric is significant |
| §6 Llama | `$0.00` with the local-serving note |

Then stop the database (`docker stop supabase_db_tos-rag`), reload, and confirm every section shows its `NoData` card and the page does not crash.

- [ ] **Step 14: Commit** (only with user approval)

```bash
git add -A packages/shared packages/ui apps/frontend
git commit -m "dashboard: render from stored analysis_results, delete the sample data"
```

---

### Task 4: Held-out subset table and the judge-validation tile

PRD §12 item 4 requires the held-out set shown separately from the full set. The judge tile is the approved addition.

**Files:**
- Modify: `apps/frontend/src/views/DashboardView.tsx`

**Interfaces:**
- Consumes: `DashboardData.heldOut` and `DashboardData.judge` from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Add the held-out table under §4**

Below the full-set table in §4, inside the same `Section`:

```tsx
{data.heldOut && (
  <div className="mt-8">
    <p className={EYEBROW}>
      {data.heldOut.label} · n = {data.heldOut.nQuestions}
    </p>
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={cn(HEAD_CELL, "text-left")}>Metric</TableHead>
            <TableHead className={HEAD_CELL}>Llama 3.1 8B</TableHead>
            <TableHead className={HEAD_CELL}>Claude Opus 4.8</TableHead>
            <TableHead className={HEAD_CELL}>W–L–T</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.heldOut.rows.map((m) => (
            <TableRow key={m.metric}>
              <TableCell className={cn(NUM_CELL, "text-foreground text-left")}>
                {m.label}
              </TableCell>
              <TableCell className={NUM_CELL}>
                <MeanCI value={m.llama} />
              </TableCell>
              <TableCell className={NUM_CELL}>
                <MeanCI value={m.opus} strong={(m.opus?.mean ?? 0) > (m.llama?.mean ?? 0)} />
              </TableCell>
              <TableCell className={cn(NUM_CELL, "font-mono")}>
                {m.wins}–{m.losses}–{m.ties}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
    <p className="bg-muted text-ink-soft mt-3 rounded-lg p-4 text-[13px] leading-relaxed">
      {data.heldOut.rows[0]?.note}
    </p>
  </div>
)}
```

The note comes from the parser and already says no paired test is computed at this sample size, so no p-value column appears.

- [ ] **Step 2: Add the judge tile after §4's tables**

```tsx
{data.judge && (
  <Card className="mt-8 gap-0 p-6">
    <p className={EYEBROW}>Judge validation</p>
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <p className="text-foreground font-mono text-[34px] font-bold leading-none">
        κ = {data.judge.kappa.toFixed(2)}
      </p>
      <Badge variant={data.judge.passes ? "default" : "destructive"}>
        {data.judge.passes ? "gate passed" : "gate failed"}
      </Badge>
      <span className="text-muted-foreground font-mono text-[12.5px]">
        threshold {data.judge.threshold.toFixed(2)} · {data.judge.band}
      </span>
    </div>
    <p className="text-ink-soft mt-4 max-w-[62ch] text-[13.5px] leading-relaxed">
      {data.judge.interpretation}
    </p>
    <div className="text-muted-foreground mt-4 flex flex-wrap gap-6 font-mono text-[12.5px]">
      <span>
        {(data.judge.percentAgreement * 100).toFixed(0)}%{" "}
        <span className="text-ink-soft">raw agreement</span>
      </span>
      <span>
        n = {data.judge.n} <span className="text-ink-soft">hand-labelled</span>
      </span>
      {data.judge.kappaCI && (
        <span>
          95% CI {data.judge.kappaCI[0].toFixed(2)}–{data.judge.kappaCI[1].toFixed(2)}
        </span>
      )}
    </div>
  </Card>
)}
```

Check `packages/ui/src/index.ts` for `Badge`'s available variants before using `"default"` / `"destructive"`; substitute whatever the primitive actually exposes.

- [ ] **Step 3: Add the sampling caveat**

The κ figure describes a verdict-balanced sample (25 accurate / 25 incorrect), not the ~83%-accurate population, and only judge-decided rows were validated. Both caveats are in the payload's `caveats` key. Surface them rather than paraphrasing: extend `JudgeValidation` in `results.ts` with `caveats: string[]`, read `payload["caveats"]` (guarding that it is an array of strings), and render them as a small list under the tile. Add a parser test asserting the caveats survive.

- [ ] **Step 4: Typecheck and view**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

Then `pnpm dev`, open `#/results`, and confirm: the held-out table shows Llama `0.40` and Opus `1.00` with W–L–T `3–0–7` over 10 pairs, and the judge tile reads `κ = 0.92`, gate passed, 96% raw agreement, n = 50.

- [ ] **Step 5: Commit** (only with user approval)

```bash
git add apps/frontend/src/views/DashboardView.tsx packages/shared/src/results.ts packages/shared/test/results.test.ts
git commit -m "dashboard: add the held-out subset table and the judge-validation tile"
```

---

### Task 5: Correct the narrative copy

Every "read it this way" paragraph was written against the sample numbers and is now false. This is the task that makes the page honest rather than merely live.

**Files:**
- Modify: `apps/frontend/src/views/DashboardView.tsx`

**Interfaces:**
- Consumes: `DashboardData`.
- Produces: no new exports.

- [ ] **Step 1: Find every hardcoded claim**

Run: `grep -n "0\.\|71×\|recursive\|2\.4s\|+0\.19\|Identical input" apps/frontend/src/views/DashboardView.tsx`

The known false claims, all in JSX prose:

| Location | Current claim | Reality |
|---|---|---|
| §2 "Read it this way" | "256-token chunks win in every strategy" | False — `sentence:512` (0.90) beats `sentence:256` (0.70) |
| §2 | "Sentence chunking peaks highest overall (0.68)" | Wrong number; the peak is 0.90 |
| §2 | "recursive × 256 is the configuration carried into Phase 2" | Wrong config — it is `sentence:512` |
| §3 | "The size effect is non-monotonic: 256 beats both" | Still true (128 = 0.63, 256 = 0.77, 512 = 0.70) but must not be hardcoded |
| §5 | "Opus buys +0.19 truthfulness for 2.4s" | Both numbers wrong; Opus was *faster* than local Llama |
| §6 | "The 71× cost gap" | Meaningless — the local arm is $0.00 |
| §6 | "Identical input volume" | False — 113k vs 75k tokens, and not comparable across tokenizers |

- [ ] **Step 2: Rewrite §2's paragraph to interpolate**

```tsx
<p className="text-ink-soft text-[13.5px] leading-relaxed">
  Darker cells scored higher. The best configuration is{" "}
  <span className="text-foreground font-mono text-[12.5px]">
    {data.winner}
  </span>
  , ringed above, and it is the configuration carried into Phase 2. The spread
  across the grid is wide, but the intervals overlap — see §4 for what that
  does to significance.
</p>
```

- [ ] **Step 3: Rewrite §3's note without hardcoded values**

```tsx
{bySize && (
  <p className="bg-muted text-ink-soft mt-4 rounded-lg p-4 text-[13px] leading-relaxed">
    The size effect is non-monotonic:{" "}
    {[...bySize].sort((a, b) => b.value - a.value)[0]!.label.trim()} scores
    highest, so retrieval precision and context sufficiency trade off around
    that point rather than improving with size.
  </p>
)}
```

- [ ] **Step 4: Add the permutation-floor note to §4**

Nothing on this page is significant, and a reader needs to know that is a property of the design, not a rendering failure:

```tsx
{data.phase2.rows.find((r) => r.floorNote)?.floorNote && (
  <p className="bg-muted text-ink-soft mt-4 rounded-lg p-4 text-[13px] leading-relaxed">
    {data.phase2.rows.find((r) => r.floorNote)!.floorNote}
  </p>
)}
```

Also update §4's `lead` prop: the current text promises "Exact Wilcoxon signed-rank p-values with Holm correction", which is right, but add that the family of tested metrics was fixed before the p-values were seen — that pre-declaration is what makes the correction defensible.

- [ ] **Step 5: Rewrite §5's paragraph**

```tsx
<p className="text-ink-soft text-[13px] leading-relaxed">
  Retrieval is effectively free and identical across generators — both arms
  ran the same frozen configuration, so the entire wall-clock difference is
  generation. The hosted model is not slower here: the baseline runs on local
  hardware, so this comparison measures the machine as much as the model.
</p>
```

- [ ] **Step 6: Rewrite §6's footnote**

```tsx
<p className="bg-muted text-ink-soft mt-5 rounded-lg p-4 text-[13px] leading-relaxed">
  {data.costNote}
  {data.tokenComparabilityNote ? ` ${data.tokenComparabilityNote}` : ""}
</p>
```

Both strings come from the payload, so this footnote can never drift from the analysis again.

- [ ] **Step 7: Verify no experimental number is hardcoded**

Run: `grep -nE '[^0-9][0-9]\.[0-9]{2}|[0-9]+×' apps/frontend/src/views/DashboardView.tsx`

Expected: matches only in styling (`text-[13.5px]`, opacity values, `1e-9`) and `toFixed` calls — no claim about a result. Any survivor is a bug.

- [ ] **Step 8: Read the page end to end**

Run `pnpm dev` and read `#/results` as a examiner would. Every sentence must be true of the numbers beside it. In particular §4 should now read as "no separable difference, and here is why the design cannot resolve one", not as a broken table.

- [ ] **Step 9: Commit** (only with user approval)

```bash
git add apps/frontend/src/views/DashboardView.tsx
git commit -m "dashboard: rewrite the narrative copy from stored data"
```

---

### Task 6: Close the report's last `[PENDING]`

**Files:**
- Modify: `docs/report.md` (lines ~25–34 draft-status note, ~808 §4.6)
- Modify: `docs/report-notes.md` (append)

**Interfaces:**
- Consumes: the finished dashboard.
- Produces: a report with no `[PENDING]` markers in its body.

- [ ] **Step 1: Rewrite §4.6's pending sentence**

Replace the bracketed marker at `docs/report.md:808`:

```
The dashboard renders the Phase 1 main table, the 5×3 Truthfulness heatmap, per-factor
bar charts, the Phase 2 paired table and held-out subset, latency box plots, the cost
table, and the judge-validation gate. All dashboard data comes from the results API
reading `analysis_results`; nothing is computed client-side beyond formatting. Where the
analysis stored no confidence interval, the interface shows the stored reason rather than
an interval, and where a payload is absent the corresponding figure states its absence.
```

- [ ] **Step 2: Update the draft-status note**

At `docs/report.md:31`, the note says the §4.6 wiring marker is the only remaining `[PENDING]`. Rewrite that clause to say no `[PENDING]` markers remain in the body.

- [ ] **Step 3: Verify**

Run: `grep -n "PENDING" docs/report.md`
Expected: no matches in the body. (Matches inside the §3.8 deviations table describing historical state are fine — read each hit before deleting it.)

- [ ] **Step 4: Append a report-notes entry**

Add a dated 2026-08-07 entry to `docs/report-notes.md` recording: the sample data is deleted; the dashboard's six figures plus held-out and judge tiles read `analysis_results`; the fabricated `mean ± 0.07` intervals are gone and real BCa intervals (several legitimately absent) are shown; the `@8` labels are corrected to `@5`; the heatmap highlight had been pinned to the superseded `recursive:256` winner; the latency payloads gained five-number summaries; and the narrative copy is now interpolated from payload strings so it cannot drift again.

- [ ] **Step 5: Commit** (only with user approval)

```bash
git add docs/report.md docs/report-notes.md
git commit -m "report: close the §4.6 dashboard-wiring PENDING marker"
```

---

## Verification

Before calling this done, all of these must have been run with their output read:

```bash
pnpm typecheck                       # zero errors
pnpm test                            # all workspace suites green
cd analysis && uv run pytest         # 141 + new latency tests green
grep -rn "SAMPLE_" apps packages     # no matches
grep -n "PENDING" docs/report.md     # no body matches
```

Plus the manual browser pass in Task 3 Step 13, in both states: database up (real numbers, checked against the table there) and database down (empty states, no crash).
