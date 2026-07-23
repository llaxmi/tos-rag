# Design — Evaluator (Headline slice): Deterministic metrics + CRAG judge

**Date:** 2026-07-23
**Status:** Draft for review
**Governs:** per-run scoring into the `evals` table (PRD §8.7, §10).
**Related:** PRD §10.1 (char-span), §10.3 (CRAG correctness / Truthfulness), §10.5 (SQuAD),
§10.6 (abstention). Depends on the ground-truth set (`corpus/questions/*.jsonl`).

## 1. Purpose

Turn each run (question + retrieved chunks + generated answer) into a scored `evals` row. The
headline number is **CRAG correctness** (`crag_score`), whose per-question mean drives
`Truthfulness = accuracy_rate − hallucination_rate` (PRD §7) — the metric that picks the Phase-1
winner. Without it, runs cannot be ranked.

## 2. Scope (this slice — "headline first")

Filled this session:

- `char_precision`, `char_recall`, `hit_at_8` — from `charSpanMetrics` (existing).
- `squad_f1`, `squad_em` — from `squadScore` (existing).
- `crag_score ∈ {-1, 0, 1}` + `judge_explanation` — rules + Sonnet judge (new).

Deferred (left `NULL`), each in its own follow-up because each adds a distinct dependency:

- `faithfulness` — RAGAS-style, needs the 2-call judge (PRD §10.2).
- `cosine_sim` — needs the embedder (answer-vs-answer embeddings, §10.5).
- `cost_usd` — Phase-2 reporting concern; uniform across Phase-1 (all Llama).

Design goal: the evaluator's only external dependency this slice is the **`Judge` port**. Everything
else is pure.

## 3. Architecture (dependency injection, matching the repo)

### Pure core — `packages/core/src/eval/`

```ts
// The injected judge port. Core owns the prompt and the parsing; the port only
// performs the model call. Faked in tests.
export interface Judge {
  complete(prompt: string): Promise<string>;
}

export interface EvaluateInput {
  qtype: Qtype;
  goldSpans: DocSpan[];        // [] for unanswerable
  expectedAnswer: string;
  answer: string;              // the generated answer
  retrieved: DocSpan[];        // the k retrieved chunk spans (doc + char range)
}

export interface EvalScores {
  char_precision: number | null;
  char_recall: number | null;
  hit_at_8: number | null;     // k-agnostic "any overlap"; column rename is a separate task
  squad_f1: number;
  squad_em: number;
  crag_score: -1 | 0 | 1;
  judge_explanation: string;
  faithfulness: null;          // deferred
  cosine_sim: null;            // deferred
  cost_usd: null;              // deferred
}

export function evaluateRun(input: EvaluateInput, deps: { judge: Judge }): Promise<EvalScores>;
```

- `eval/crag.ts` — `buildCragPrompt(question, expected, answer)` and
  `parseCragVerdict(text): { score: -1 | 1; explanation: string }` (JSON first, regex fallback).
- `eval/evaluate.ts` — `evaluateRun`: assembles deterministic metrics, applies the CRAG decision
  order, calls `judge.complete` only for case 3.

### Backend adapter — `apps/backend/src/adapters/judge.ts`

`createJudge(env): Judge` → raw `fetch` to the Anthropic Messages API with `MODEL_IDS.judge`
(`claude-sonnet-5`), `temperature: 0`, mirroring `deps/live.ts` `generateOpus`. Throws a clear
error if `ANTHROPIC_API_KEY` is unset.

## 4. CRAG decision logic (PRD §10.3)

Given the generated `answer` and the question's `expectedAnswer`, in order:

1. `isAbstention(answer)` → `crag_score = 0` (Missing), `judge_explanation = "abstained"`. No call.
2. `normalizeAnswer(answer) === normalizeAnswer(expectedAnswer)` (SQuAD normalization) →
   `crag_score = +1` (Accurate), explanation = "exact match". No call.
3. Otherwise → `judge.complete(buildCragPrompt(...))` → parse → `+1` (accurate) or `−1` (incorrect).

The judge prompt: reference-guided, **binary**, explanation-before-score, temp 0, JSON output,
few-shot examples adapted from `facebookresearch/CRAG` `prompts/templates.py`.

Note on unanswerable questions: gold spans are empty ⇒ char metrics are `null`. A correct
abstention scores `0` (Missing) via rule 1; a hallucinated answer (≠ "I don't know") falls to the
judge, which rules it incorrect against the expected `"I don't know"`. Abstention precision/recall
(§10.4) is an aggregate computed later in Python, not here.

## 5. Judge robustness (PRD §10.2 guards, applied to CRAG)

- Structured JSON expected: `{ "explanation": string, "score": "accurate" | "incorrect" }`.
- Parse JSON; on failure, regex-scan for the score token; if still unresolved, throw with the raw
  text so the caller can retry/inspect (no silent default that would bias Truthfulness).
- Judge called at `temperature: 0` for maximal determinism (fp-level nondeterminism documented).

## 6. Testing (hermetic)

Fake `Judge` returning canned strings. Cases:

- Abstention answer → score 0, judge **not** called.
- Normalized exact match → score +1, judge **not** called.
- Mismatch → judge called once; `+1` and `−1` both parsed from JSON.
- Malformed judge JSON → regex fallback recovers the score; unrecoverable → throws.
- Unanswerable (empty gold spans) → `char_*`/`hit_at_8` are null; squad still computed.
- Deterministic metric assembly matches `charSpanMetrics` / `squadScore` directly.

## 7. Out of scope (follow-ups)

- Faithfulness, cosine, cost (each its own slice).
- Orchestrator wiring (`run-one`) — the evaluator is a library the orchestrator will call; no
  end-to-end run is produced this session.
- Renaming `evals.hit_at_8` → `hit_at_k` (small migration, separate).
- Judge validation vs human labels / Cohen's κ (PRD §10.3) — a manual protocol.

## 8. Acceptance

- `evaluateRun` returns a complete `EvalScores` for answerable and unanswerable inputs.
- Rules short-circuit the judge for abstention and exact-match (asserted by call-count in tests).
- CRAG JSON parses, with a regex fallback; unrecoverable output throws rather than defaulting.
- All new tests hermetic (no network/model/DB); `typecheck` clean.
