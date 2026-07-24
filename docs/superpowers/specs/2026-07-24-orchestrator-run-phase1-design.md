# Design — Orchestrator: run-phase1 (resumable)

**Date:** 2026-07-24
**Status:** Draft for review
**Governs:** producing the Phase-1 `runs` + `evals` rows (PRD §4 `run-one`, §7, §16).
**Depends on:** seeded `questions`/`documents` (#17), ingested `chunks`, the evaluator (#10).

## 1. Purpose

Nothing has executed the experiment yet. The orchestrator drives the full pipeline for every
Phase-1 combination and persists each result, so the configs can be ranked.

Phase 1 = **15 configs × 20 Round-1 questions × Llama = 300 runs**. Each run:
retrieve → generate → evaluate → write a `runs` row + an `evals` row. Resumable via the
`runs` unique key `(phase, config_id, model, question_id)`.

## 2. Interface

A local CLI, `pnpm run-phase1`, alongside `ingest` / `seed-questions` (the Node-only, script-driven
pattern). The PRD §4 `/api/experiment/run-one` HTTP endpoint is **not** built: its rationale
(Cloudflare Worker subrequest caps → one run per invocation) is void since Cloudflare was dropped
(§15).

```
pnpm run-phase1                 # all 300, resuming past completed runs
pnpm run-phase1 --config sentence:256   # restrict to one config (optional)
pnpm run-phase1 --limit 5       # first N questions per config (smoke test)
```

## 3. Components (dependency injection, matching the repo)

### 3.1 Pure `runOne` — `@tos-rag/core`

The testable heart. No I/O; all effects injected.

```ts
export interface OrchestratorDeps {
  retrieve: (question: string, opts: { strategy: Strategy; chunkSize: number }) => Promise<RetrievedChunk[]>;
  generate: (prompt: string, model: GeneratorModel) => Promise<GenerationResult>;
  judge: Judge;
}

export interface RunOneInput {
  question: { id: string; docId: string; expectedAnswer: string; goldSpans: Span[] };
  config: { strategy: Strategy; chunkSize: number };
  model: GeneratorModel;   // 'llama' | 'opus'
}

export interface RunOneResult {
  retrieved: { doc_id: string; char_start: number; char_end: number; score: number }[];
  answer: string;
  retrieval_ms: number;
  generation_ms: number;
  input_tokens: number;
  output_tokens: number;
  scores: EvalScores;
}

export function runOne(input: RunOneInput, deps: OrchestratorDeps): Promise<RunOneResult>;
```

Behavior:
1. `retrieve(question.question, config)` — **whole corpus**, no doc filter (PRD §7). Time it.
2. `generate(buildRagPrompt(question, retrieved), model)`.
3. `evaluateRun({ question, expectedAnswer, answer, goldSpans: goldSpans.map(s => ({ ...s, docId: question.docId })), retrieved: retrieved.map(toDocSpan) }, { judge })`.
4. Assemble `RunOneResult` (retrieved reduced to `{doc_id,char_start,char_end,score}`).

Gold spans carry no `docId` in storage; they are offsets into the question's own document, so the
question's `docId` is attached before scoring (the char-span metrics group by document).

### 3.2 DB helpers — `@tos-rag/db`

- `getQuestions(opts?: { phase1?: boolean }): Promise<QuestionRow[]>` — read seeded questions
  (id, doc_id, qtype, question, expected_answer, gold_spans, phase1).
- `findRun(key: { phase; configId; model; questionId }): Promise<bigint | null>` — resume check.
- `writeRun(run: RunInsert, scores: EvalScores): Promise<bigint>` — insert `runs` then `evals` in
  one `$transaction`; returns the run id. The retrieved spans go to the `runs.retrieved` `Json`
  column; `evals.hit_at_8` receives the k-agnostic hit from `EvalScores`.

### 3.3 CLI — `apps/backend/src/scripts/run-phase1.ts`

Wires real deps: embedder → `createLiveDeps` (retrieve/generate) + `createJudge` (judge) + the DB
helpers. Requires `DATABASE_URL`, `ANTHROPIC_API_KEY` (judge), and a reachable Ollama.

Loop, sequential (simple, rate-safe; Llama is local, judge is one Sonnet call/run):

```
phase = 1; model = 'llama'
questions = getQuestions({ phase1: true })        // 20
for config in the 15 (strategy × size):
  configId = resolveConfigId(config)
  for q in questions:
    if findRun({phase, configId, model, questionId: q.id}): skip (log), continue
    try:
      result = runOne({question: q, config, model}, deps)
      writeRun({phase, configId, model, questionId: q.id, ...result}, result.scores)
    catch e:
      log error for (config, q); continue      // nothing written → retried next run
  log progress (done / skipped / failed, running N/300)
```

## 4. Error handling

- Per-run `try/catch`: a failure (judge parse error, generation/HTTP error, unparseable verdict)
  is logged with `(config, question_id)` and the loop continues. Because the row is only written on
  full success, a re-run retries exactly the failures — no partial/duplicate rows.
- A missing config's chunks (config not yet ingested) surfaces as empty retrieval → still runs and
  scores (likely an abstention/low score); the CLI logs a warning if a config returns zero chunks
  for every question, since that signals "not ingested" rather than a real result.

## 5. Testing (hermetic)

- `runOne` with fake `retrieve`/`generate`/`judge`: assembles the run + eval correctly; passes the
  whole-corpus retrieval through; attaches `docId` to gold spans; reduces `retrieved` to the stored
  shape; propagates a judge error.
- The loop's resume logic: a small pure `planRuns(configs, questions, alreadyDone)` helper that
  returns the pending (config, question) pairs, unit-tested (done set skips correctly). Keeps the
  CLI thin.
- DB helpers require a live DB (like `insertChunks`) — not unit-tested here.

## 6. Out of scope

- **Running** Phase 1 — needs `chunks` ingested (`pnpm ingest --all-configs`); this session builds
  and tests the orchestrator only.
- **Phase 2** (Opus, winning config, 30 questions) — `runOne` is phase/model-agnostic and will be
  reused by a later `run-phase2`; not built now.
- Picking the winner / analysis (Python `analysis/`, PRD §11).
- Concurrency/parallelism — sequential is enough at this scale; revisit only if too slow.

## 7. Acceptance

- `runOne` unit tests pass hermetically; `planRuns` resume logic tested; typecheck clean.
- `pnpm run-phase1` (with a live DB + ingested chunks) writes `runs` + `evals` for every pending
  (config, question), skips completed ones, and a second run is a no-op (PRD §16 #3).
- Every written `evals` row traces to a `runs` row (PRD §16 #4).
