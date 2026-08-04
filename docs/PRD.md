# PRD — tos-rag: An Empirical Study of RAG Pipeline Design

**Project**: Final Year Project, Gandaki College of Engineering and Science / Pokhara University
**Authors**: Laxmi Lamichhane & Sudha Paudel
**Status**: Draft for review · **Target completion**: 2026-08-14
**Governs**: the software that produces the study's results and the public demo. The research questions themselves are defined in `docs/FYP_ Proposal.md`; this PRD defines *what we build* to answer them.

---

## 1. Overview & Objectives

The study is a two-phase controlled experiment over Terms of Service (ToS) documents:

- **Objective 1 (Phase 1)** — measure the effect of *chunking strategy* and *chunk size* on retrieval and answer quality. 5 strategies × 3 sizes = **15 configurations**, generator fixed to Llama 3.1 8B, 20 questions (10 per document). The best configuration advances.
- **Objective 2 (Phase 2)** — under the winning configuration, compare a paid generator (**Claude Opus 4.8**) against an open-source generator (**Llama 3.1 8B**) on answer quality, latency, and token cost, over all 30 questions (the 10 questions unused in Phase 1 form a held-out subset, reported separately).

The software deliverable is a reproducible pipeline that runs both phases, persists every run and every metric score to Postgres, computes inferential statistics, and serves a public demo (chat with evidence + results dashboard).

Total experimental runs: **300 Phase 1** (15 configs × 20 questions) + **60 Phase 2** (2 models × 30 questions) = **360 runs**.

## 2. Out of Scope

Explicitly excluded (documented as future work in the report):

- Document upload / user-supplied corpora — the demo chats over the fixed 2-document corpus only.
- Hybrid retrieval (BM25 + dense), reranking, query rewriting.
- Varying the prompt template, embedding model, or retrieval depth k.
- Sentence-augmented chunking (SAC) and other augmentation schemes.
- More than 2 experimental documents (Netflix Privacy Statement stays in the repo but out of the experiment).
- Fine-tuning any model.

## 3. Deliverables

1. **Experiment results**: all 360 runs and per-question metric scores in Postgres (`runs`, `evals`), plus computed statistics (`analysis_results`).
2. **Demo**: chat over the corpus with retrieved-chunk evidence, and a results dashboard rendering every table/figure in §12.
3. **Reproducible pipeline code**: the monorepo below; any collaborator with the env vars can re-run ingestion, both phases, and the analysis.

## 4. Architecture

Everything runs on **Cloudflare Workers** + **Supabase** (Postgres + pgvector). The Anthropic API is called via `fetch`; Workers AI via the `env.AI` binding.

### Monorepo layout

```
apps/backend      Hono Worker (wrangler)
  /api/ask                demo RAG endpoint (winning config)
  /api/experiment/run-one one question × config × model per invocation; resumable
  /api/results/*          dashboard data (read-only aggregates)
  /admin/ingest           chunk + embed one config (admin-token gated)
apps/web          React + Vite SPA (served as Cloudflare static assets): chat + dashboard
packages/core     shared library used by the Worker AND local scripts:
                  chunkers, tokenizer, embedder/generator clients, retriever,
                  prompts, deterministic metrics, zod schemas, DB types
analysis/         Python stats script (scipy/statsmodels) + figure generation
corpus/           archival PDFs; corpus/canonical/*.md (frozen, sha256 recorded);
                  corpus/questions/*.jsonl
```

### Exact model IDs

| Role | Model | Notes |
|---|---|---|
| Embedder | `@cf/google/embeddinggemma-300m` | 768-dim, **512-token input max**, batch ≤ 100 texts/call |
| Open-source generator | `@cf/meta/llama-3.1-8b-instruct-fast` | 128K ctx, fp8-quantized, supports `seed` + `temperature` (base variant deprecated on Workers AI 2026-05-30) |
| Paid generator | `claude-opus-4-8` | Anthropic API |
| LLM judge | `claude-sonnet-5` | Anthropic API |

### Cross-cutting constraints

- Workers AI free tier: 10k neurons/day ≈ ~530 RAG generations/day on `-fast`; embeddings negligible. The **$5 Workers Paid plan is recommended** (30 s CPU, 1000 subrequests/invocation) and fits the proposal budget.
- Workers AI latency varies by GPU datacenter routing → report **medians and p95**, and run each phase in a consistent session.
- Generation params fixed everywhere: `temperature: 0`, fixed `seed`, explicit `max_tokens` (Workers AI default is 256 — a silent-truncation trap), one fixed prompt template (§10.6).

## 5. Corpus Specification

### Documents

| doc_id | Title | Source | License |
|---|---|---|---|
| `github-tos` | GitHub Terms of Service | Markdown from the `github/site-policy` repo | CC0-1.0 |
| `netflix-tou` | Netflix Terms of Use | Official HTML page → turndown → hand-clean | quoted for research/criticism (fair use); attribution in report |

The PDFs in `corpus/` remain **archival snapshots** only; they are not parsed by the pipeline.

### Canonical Markdown format

One frozen `.md` file per document: `corpus/canonical/<doc_id>.md`. **All chunk boundaries and gold clause spans are character offsets into this exact text.**

> **Invariant (asserted in code, tested in CI):** `chunk.text === canonical.slice(chunk.char_start, chunk.char_end)`

### Conversion procedure

1. GitHub ToS: take the Markdown source from `github/site-policy`, strip front-matter, normalize line endings to `\n`.
2. Netflix ToU: fetch official HTML, convert with `turndown`, then hand-clean (remove nav/footer, fix list markers, normalize whitespace) — cleaning decisions logged in `corpus/canonical/CHANGELOG.md`.
3. Record `sha256` of each canonical file in `corpus/canonical/checksums.txt` and in the `documents` DB table.

### Freeze protocol

After gold-span annotation begins, canonical files are **frozen**. Any edit invalidates every span → bump the document's `version`, re-run the checksum, and re-annotate. CI fails if a canonical file's sha256 differs from `checksums.txt`.

## 6. Ground-Truth Specification

Q&A pairs already exist in the two question PDFs; the work is conversion to JSONL + gold-span annotation against the canonical Markdown.

### JSONL schema (`corpus/questions/<doc_id>.jsonl`, one object per line)

```json
{
  "id": "github-q01",
  "doc_id": "github-tos",
  "qtype": "factual",
  "question": "How much notice does GitHub give before changing fees?",
  "expected_answer": "At least 30 days' advance notice.",
  "gold_spans": [{ "char_start": 18240, "char_end": 18389 }],
  "phase1": true
}
```

- `qtype ∈ {factual, multi_clause, comparison, unanswerable}`.
- `unanswerable` questions have `gold_spans: []` and `expected_answer: "I don't know"`.
- `phase1: true` for the 20 Phase-1 questions; the other 10 are held-out (Phase 2 only).

### Annotation protocol

1. A helper script (`packages/core` + tsx) fuzzy-searches `expected_answer` against the canonical text and proposes candidate spans; the annotator confirms/adjusts.
2. **Both annotators independently verify every span**; disagreements resolved by discussion; report Cohen's κ on the initial pass.
3. A validation script asserts every span slices to non-empty text and every `doc_id` exists.

## 7. Experimental Design

### Factors (Phase 1) — 15 configurations

- **Chunking strategy** (5): `fixed`, `recursive`, `sentence`, `semantic`, `section`.
- **Chunk size** (3): **128 / 256 / 512 Gemma tokens** (measured with embeddinggemma's own tokenizer — see §8.2; 512 is the embedder's hard serving limit).

### Constants (both phases)

| Constant | Value |
|---|---|
| Retrieval depth | **k = 5** (amended 2026-07-23; was k = 8 — see §15 #11) |
| Retrieval scope | whole corpus (both documents) per query |
| Distance | cosine, **exact scan** (no ANN index), tiebreak `ORDER BY embedding <=> q, id` |
| Chunk overlap | 0 (literature: overlap adds cost without quality gains — Amiri & Bocklitz 2025; Bennani & Moslonka 2025/26) |
| Embedder | `@cf/google/embeddinggemma-300m` |
| Prompt template | fixed (§10.6), includes abstention instruction |
| Generation | temperature 0, fixed seed 42, explicit max_tokens 1024 |

### Phases

- **Phase 1**: 15 configs × 20 questions (`phase1: true`) × Llama-fast = 300 runs. Winner = best mean **Truthfulness** (ties broken by char-recall@8, then latency).
- **Phase 2**: winning config × {Llama-fast, Claude Opus 4.8} × all 30 questions = 60 runs. Held-out 10 reported separately.

## 8. Module Specifications

Seven modules, all in `packages/core`, identical code in Worker and local scripts.

### 8.1 Loader

```ts
interface CanonicalDoc { docId: string; text: string; sha256: string; version: number }
loadCanonical(docId): CanonicalDoc   // verifies sha256 against checksums.txt
```

### 8.2 Tokenizer

The measuring stick for chunk size is the **Gemma tokenizer** (embeddinggemma's own, loaded via `@huggingface/transformers` `AutoTokenizer`) — it is the binding constraint (512-token embed limit), so measuring in embedder tokens guarantees no silent truncation. Used **only at ingestion time**; exposed as an interface so tests can inject a fast fake:

```ts
interface TokenCounter { count(text: string): number }
```

### 8.3 Chunker

All 5 strategies are **hand-rolled** (~50–100 lines each). LangChain JS splitters are ruled out: they don't expose char offsets and they trim chunks, breaking the offset invariant.

```ts
interface Chunk { charStart: number; charEnd: number; text: string; tokenCount: number }
type Chunker = (canonical: string, maxTokens: number, deps: ChunkerDeps) => Chunk[] | Promise<Chunk[]>
```

- **fixed** — token-budget packing over raw characters, no boundary awareness.
- **recursive** — recursive character splitting on separator hierarchy (`\n\n` → `\n` → sentence → word), offsets preserved (no trimming).
- **sentence** — sentence segmentation via `Intl.Segmenter` (native char offsets) + abbreviation-merge post-pass; pack sentences into token budget.
- **semantic** — LlamaIndex-style: embed adjacent sentence groups, cosine distance between neighbors, breakpoints at the 95th percentile of distances, then cap at the token budget. Takes an `embed` dependency (injected; faked in tests).
- **section** — heading-based (Markdown `#`..`######`) packing; oversized sections recursively split.

Every chunker output passes: offset invariant, `tokenCount ≤ maxTokens`, full coverage of non-whitespace text, no overlaps, monotonically increasing offsets.

### 8.4 Embedder

```ts
embedBatch(texts: string[]): Promise<Float32Array[]>  // batches of ≤ 100
```
Asserts every input ≤ 512 Gemma tokens at ingestion; verifies vectors are L2-normalized (else normalizes and logs).

### 8.5 Vector Store & Retriever

Chunks stored per config in Supabase (`chunks`, `vector(768)`). Retrieval via a Postgres RPC `match_chunks(config_id, query_embedding, k)` doing an **exact scan** filtered by config — perfect recall, deterministic, trivial at this scale (~few thousand rows/config).

### 8.6 Generator

```ts
interface GenResult { answer: string; inputTokens: number; outputTokens: number; latencyMs: number }
generate(model: 'llama' | 'opus', prompt: string): Promise<GenResult>
```
`llama` → `env.AI.run` (or REST when local); `opus` → Anthropic Messages API via fetch. Both temp 0, seed (where supported), explicit max_tokens.

### 8.7 Evaluator

Computes all §10 metrics for a run; deterministic metrics in TS (`packages/core`), judge/faithfulness via Claude Sonnet 5; per-question scores written to `evals`.

## 9. Data Model (Supabase / Postgres + pgvector)

```sql
create table documents (
  id text primary key,               -- 'github-tos'
  title text not null,
  sha256 text not null,
  version int not null default 1,
  char_length int not null
);

create table configs (
  id serial primary key,
  strategy text not null check (strategy in ('fixed','recursive','sentence','semantic','section')),
  chunk_size int not null check (chunk_size in (128, 256, 512)),
  unique (strategy, chunk_size)
);

create table chunks (
  id bigserial primary key,
  config_id int not null references configs(id),
  doc_id text not null references documents(id),
  char_start int not null,
  char_end int not null,
  text text not null,
  token_count int not null,
  embedding vector(768) not null
);
create index on chunks (config_id);

create table questions (
  id text primary key,               -- 'github-q01'
  doc_id text not null references documents(id),
  qtype text not null check (qtype in ('factual','multi_clause','comparison','unanswerable')),
  question text not null,
  expected_answer text not null,
  gold_spans jsonb not null,         -- [{char_start, char_end}]
  phase1 boolean not null
);

create table runs (
  id bigserial primary key,
  phase int not null check (phase in (1,2)),
  config_id int not null references configs(id),
  model text not null,               -- '@cf/meta/llama-3.1-8b-instruct-fast' | 'claude-opus-4-8'
  question_id text not null references questions(id),
  retrieved jsonb not null,          -- [{chunk_id, score, char_start, char_end, doc_id}] (k=5, ordered)
  answer text not null,
  retrieval_ms int, generation_ms int,
  input_tokens int, output_tokens int,
  created_at timestamptz default now(),
  unique (phase, config_id, model, question_id)   -- resume key
);

create table evals (
  run_id bigint primary key references runs(id),
  char_precision real, char_recall real, hit_at_8 real,
  faithfulness real,                 -- NULL for abstentions
  crag_score int check (crag_score in (-1, 0, 1)),
  judge_explanation text,
  squad_f1 real, squad_em real,
  cosine_sim real,
  cost_usd numeric(10,6)
);

create table analysis_results (
  id bigserial primary key,
  analysis text not null,            -- 'phase1_main', 'phase1_factor_strategy', 'phase2_paired', ...
  payload jsonb not null,            -- means, CIs, p-values, win counts
  computed_at timestamptz default now()
);
```

Exact-scan retrieval RPC:

```sql
create or replace function match_chunks(p_config_id int, p_query vector(768), p_k int)
returns table (chunk_id bigint, doc_id text, char_start int, char_end int, text text, score real)
language sql stable as $$
  select id, doc_id, char_start, char_end, text,
         1 - (embedding <=> p_query) as score
  from chunks
  where config_id = p_config_id
  order by embedding <=> p_query, id
  limit p_k;
$$;
```

No HNSW/IVFFlat index — exact scan gives perfect recall and deterministic ordering at this scale.

## 10. Metrics & Judge

### 10.1 Character-span retrieval quality (LegalBench-RAG style)

For gold spans G and the k=5 retrieved chunks (**merge overlapping retrieved spans first**, per document):

- `char_precision = Σ overlap / Σ retrieved-chars`
- `char_recall   = Σ overlap / Σ gold-chars`
- `hit_rate@8    = 1 if any retrieved chunk overlaps any gold span else 0` — *our own extension of LegalBench-RAG, defined exactly as stated here.*

Unanswerable questions (empty gold spans): retrieval metrics are NULL.

### 10.2 RAGAS-style faithfulness

Two Sonnet 5 calls per answer: (1) decompose the answer into atomic statements — with an explicit "no pronouns; each statement self-contained" decontextualization instruction; (2) batched NLI verdicts of each statement against the retrieved context. `faithfulness = supported / total`. Guards: enforce `verdicts.length === statements.length` with one retry; structured JSON output with regex fallback. **NULL for abstentions.** Labeled "RAGAS-style" in the report (re-implementation, not the library).

### 10.3 CRAG-style correctness (headline)

Rules first, **in this order** (amended 2026-08-02, see §15 #12): normalized exact match with the expected answer → **Accurate (+1)**; else lowercased answer == "i don't know", ignoring trailing sentence punctuation → **Missing (0)**. Otherwise a reference-guided **binary** judge (Claude Sonnet 5, temp 0, JSON, explanation-before-score, few-shot examples adapted from `facebookresearch/CRAG` `prompts/templates.py`): accurate (+1) or incorrect (−1).

`Truthfulness = accuracy_rate − hallucination_rate` (mean of per-question scores).

**Judge validation**: a stratified human-labeled sample (≥40 answers); require Cohen's κ ≥ 0.61 (substantial agreement) between judge and human labels, else iterate the judge prompt before trusting scores.

### 10.4 Abstention precision/recall

Over unanswerable questions: abstention recall = fraction answered "I don't know"; abstention precision = of all "I don't know" replies, fraction that were truly unanswerable.

### 10.5 SQuAD F1 / EM, cosine, latency, cost

- **SQuAD F1/EM**: hand-rolled ~30-line TS port replicating the official script exactly — lowercase, strip ASCII punctuation set, remove articles (a/an/the), whitespace-split; empty-answer edge cases per original. (No maintained JS port exists.)
- **Cosine similarity**: between Gemma embeddings of generated vs expected answer.
- **Latency**: retrieval_ms and generation_ms recorded per run; report median + p95 (GPU routing variance).
- **Cost**: token counts × published per-model prices → `cost_usd`; Workers AI in neurons converted at the published rate.

### 10.6 Fixed generation prompt (both models, both phases)

```
You answer questions about Terms of Service documents using ONLY the provided context.

Context:
{{numbered retrieved chunks, each tagged [doc_id §char_start–char_end]}}

Question: {{question}}

Rules:
- Answer concisely using only information from the context.
- If the answer is not in the context, reply exactly: I don't know
```

The abstention rule maps to CRAG *Missing*; faithfulness is NULL for abstentions.

## 11. Statistics Plan (Python, `analysis/`)

TS never computes inferential statistics. A Python script reads per-question scores from Postgres and writes `analysis_results`:

- **Wilcoxon signed-rank**: `scipy.stats.wilcoxon(zero_method='zsplit', method=PermutationMethod())` — exhaustive permutations at n=20, Monte Carlo at n=30. (TS is a trap: `@stdlib/stats-wilcoxon` silently falls back to the normal approximation with ties/zeros — certain with 0/1 metrics.)
- **95% CIs**: `scipy.stats.bootstrap(method='BCa', n_resamples=10_000)`.
- **Multiple comparisons**: `statsmodels.stats.multitest.multipletests(method='holm')` across the 14 best-vs-rest Phase-1 comparisons.
- Factor isolation: per-question scores averaged by strategy (across sizes) and by size (across strategies), each with BCa CIs.
- Every reported number is traceable to `runs`/`evals` rows; the script is deterministic given the DB state (fixed bootstrap seed).

## 12. Demo & Dashboard Requirements

### Chat (`/`)

- Question input over the fixed corpus (optional doc filter chips: GitHub / Netflix / both).
- **Pipeline bench** (amendment 2026-07-18): the proposal's three experimental variables are user-selectable per question — chunking strategy (5), chunk size (128/256/512), and generator (Llama / Opus) — defaulting to the winning config + Llama, with a reset-to-winner affordance. Live mode resolves the selection against the `configs` table (a not-yet-ingested config returns a clear 503); Opus requires `ANTHROPIC_API_KEY`. The constants (k=5, embedder, prompt) stay fixed.
- Answer rendered with the selected config + generator; abstentions displayed distinctly.
- **Evidence panel**: the k retrieved chunks with similarity scores, doc + section, and character ranges; clicking highlights the chunk text.
- Footer states the winning config (strategy × size) so the demo is self-describing.

### Dashboard (`/dashboard`)

1. **Phase 1 main table** — 15 configs × all metrics, mean ± 95% CI, best per column bolded.
2. **5×3 Truthfulness heatmap** (strategy × size).
3. **Per-factor bar charts** with CI error bars (by strategy, by size).
4. **Phase 2 paired table** — per metric: each model's mean + CI, difference + CI, Wilcoxon p (Holm-adjusted where applicable), per-question win counts; full set and held-out shown separately.
5. **Latency box plots** split by retrieval/generation stage (median, p95 annotated).
6. **Cost table** — tokens → USD per model.

All dashboard data comes from `/api/results/*` reading `analysis_results` (+ raw aggregates); nothing is computed client-side beyond formatting.

## 13. Milestones (4 weeks, Jul 14 → Aug 14 2026)

| Week | Scope |
|---|---|
| **W1** | Canonical corpus frozen (+sha256), Q&A JSONL + gold spans annotated (κ recorded), DB schema migrated, all 5 chunkers with unit tests passing |
| **W2** | Ingestion (15 configs embedded), retrieval RPC, generator clients, `/api/ask`, chat MVP, 3–5-question smoke test produces grounded answers |
| **W3** | Evaluator + judge, orchestrator (`run-one`, resumable), run Phase 1 → pick winner → run Phase 2 |
| **W4** | Python analysis populates `analysis_results`, dashboard complete, judge validation (κ ≥ 0.61), manual verification pass, report material exported |

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Free-tier neuron budget (10k/day ≈ 530 generations) throttles experiment | Pace runs across days, or **$5 Workers Paid plan** (fits proposal budget) |
| Workers CPU (10 ms free) / subrequest (50) limits during ingestion | `/admin/ingest` does one config per invocation; identical `packages/core` code also runs as a local script (`pnpm ingest`) writing to the same tables; paid plan raises to 30 s / 1000 |
| Workers AI non-determinism despite fixed seed | Document as best-effort; fp8 quantization noted in report; temp 0 minimizes variance |
| Judge/faithfulness JSON drift | Structured output + one retry + regex fallback; length-equality assertion |
| Silent truncation at the 512-Gemma-token embed cap | Ingestion-time assertion on every chunk's token count |
| Corpus edited after annotation | Freeze protocol: sha256 in CI; any edit bumps version and forces re-annotation |
| Silent answer truncation | Explicit `max_tokens` everywhere (Workers AI default is 256) |

## 15. Deviations-from-Proposal Log (for the defense)

| # | Proposal said | We do | Why |
|---|---|---|---|
| 1 | Llama-3.1-8B (base) | `@cf/meta/llama-3.1-8b-instruct-fast` | base variant deprecated on Workers AI 2026-05-30; `-fast` is the supported equivalent (fp8) |
| 2 | Chunk sizes 256/512/1024 | **128/256/512** Gemma tokens | embedder serving limit is 512 input tokens; 1024 would silently truncate |
| 3 | pdf-parse of corpus PDFs | Canonical Markdown from official web sources | cleaner canonical text; deterministic char offsets; PDFs kept as archival snapshots |
| 4 | Stats implied in-pipeline | Python (scipy/statsmodels) for inferential stats | exact Wilcoxon with ties/zeros and BCa bootstrap are not reliably available in JS |
| 5 | Overlap unspecified | Overlap fixed at 0 | cited literature: overlap adds cost without quality gains |
| 6 | Embedding via Workers AI (`@cf/google/embeddinggemma-300m`) | **Local** `onnx-community/embeddinggemma-300m-ONNX` (transformers.js, fp32) for both ingestion and query | Cloudflare documents neither its serving dtype nor its pooling, exposes no prompt-prefix parameter, and caps input at 512 tokens vs the model's 2048. Indexing locally and querying remotely would make retrieval metrics measure an uncharacterizable vector-space mismatch. Same weights on both sides is the control. |
| 7 | Backend deployable as a Cloudflare Worker | `/api/ask` is **Node-only** | Follows from #6: ~1.2 GB of ONNX weights cannot run in a Worker. The CF embedder was initially retained behind `EMBEDDER=cf` so the Worker path could be a config swap, gated on a local↔CF cosine parity check (`test:live`); it was removed entirely on 2026-07-22 (see the dated §15 entry below) once the Worker path was abandoned. |
| 8 | §9 `match_chunks(config_id, query, k)` | Adds `p_doc_id text default null`, filtered inside the scan | The doc filter previously ran in TypeScript *after* the RPC returned k rows, so a doc-scoped question silently came back with fewer than k chunks, or none. |
| 9 | §9 schema as written | Adds `create extension vector` and RLS (enabled, no policies) on all 7 tables | The extension is needed on a fresh project. RLS changes nothing operationally — the backend uses the service-role key, which bypasses it — but silences the Supabase "table exposed" advisor. |
| 10 | §5 GitHub ToS at `Policies/github-terms-of-service.md` | `Policies/github-terms/github-terms-of-service.md` | Upstream moved the file; the flat path is a 404. |
| 11 | Retrieval depth held constant at **k = 8** | **k = 5** | Owner decision (2026-07-23) to retrieve the top-5 chunks per query. Amends the frozen-constants set (§7); runs collected at k = 8 are not comparable and must be re-collected. |
| 12 | §10.3 rules: abstention → 0 checked *before* exact match → +1 | Exact match checked first; abstention detection ignores trailing punctuation | Owner decision (2026-08-02). The two rules disagreed about punctuation, so `"I don't know."` and `"I don't know"` scored a full point apart on identical behaviour; and scoring a correct abstention 0 made the 4 unanswerable questions unwinnable, capping a flawless Phase-1 run at 0.800. Re-scored from stored answers (`pnpm rescore-crag`) — no re-generation. **Changes the Phase-1 winner from `recursive:256` to `sentence:512`.** |

- **2026-08-02 — CRAG rule order and abstention punctuation (§10.3).** `cragScore`
  checks normalized exact match before abstention, and `isAbstention` ignores
  trailing sentence punctuation, so the two rules agree on what an abstention is.
  A correct "I don't know" on an unanswerable question is now **Accurate (+1)**,
  matching CRAG's own semantics — the abstention *behaviour* remains measured
  separately by §10.4, which is where it belongs. Only stored scores changed
  (36 rows: 34 × 0 → +1, 2 × −1 → 0); no answer was regenerated and no judge was
  re-invoked, so every `runs.answer` is untouched and the correction is
  reproducible via `pnpm rescore-crag`. Consequence: the §7 winner selection now
  yields a tie at 0.900 between `sentence:512` and `recursive:256`, broken by
  char-recall in favour of **`sentence:512`**.

- **2026-07-23 — Retrieval depth k = 8 → 5.** `RETRIEVAL_K` in `@tos-rag/core`
  is reduced from 8 to 5 chunks per query (a §7 frozen constant). This changes
  retrieval for every answer; `runs.retrieved` and all §10.1 char-span metrics are
  now computed over 5 chunks. Any runs previously stored at k = 8 are invalidated
  and must be re-collected before they can be compared with new results.

- **2026-07-22 — Cloudflare removed.** The backend runs as a Node process only;
  the Cloudflare Worker deployment path is abandoned. The open generator arm
  (Llama 3.1 8B) is served by a local Ollama runtime (`/api/generate`) instead
  of Workers AI — same model, different runtime. The `EMBEDDER=cf` query-time
  embedder is deleted (the local ONNX embedder was already the ingest embedder).
  The offline demo deps are removed; the backend now requires `DATABASE_URL`.

## 16. Acceptance Criteria

1. Chunker offset invariant (`text === canonical.slice(start, end)`) and budget/coverage assertions pass on both canonical documents for all 15 configs.
2. Smoke test (3–5 questions) produces grounded answers with evidence.
3. Orchestrator resumes after interrupt with no duplicate runs (unique key respected).
4. All 360 runs present in `runs` with complete `evals` rows.
5. `analysis_results` populated; every dashboard number traceable to DB rows.
6. Dashboard renders all six §12 figures/tables; chat demo answers with evidence chunks.
7. Judge validation κ ≥ 0.61 documented.
8. User signs off on the deviations log (§15).
