# Architecture

`tos-rag` is a controlled experiment on RAG pipeline design over Terms of Service
documents, plus a public demo of the resulting pipeline. This document describes how
the code is organised and why. `docs/PRD.md` remains the authoritative spec for
experimental design, metrics, and acceptance criteria — where the two disagree, the
PRD wins and this document should be corrected.

## 1. Stack at a glance

| Layer | Technology | Notes |
| --- | --- | --- |
| Monorepo | pnpm workspaces + Turborepo | `turbo.json` defines `dev` / `test` / `typecheck` / `build` |
| Backend | [Hono](https://hono.dev) 4 | Runs on Node via `@hono/node-server`; Node-only, the Cloudflare Worker deployment target has been abandoned (PRD §15) |
| Frontend | React 19 + Vite 7 | SPA, hash routing, no router dependency |
| Database | Supabase (Postgres + pgvector) | `vector(768)` chunks, retrieval via a `match_chunks` RPC |
| Embeddings | Local ONNX (embeddinggemma-300m, transformers.js) | Runs in-process, loaded once at boot |
| Open generator | Ollama (local) | Llama 3.1 8B via `/api/generate` (PRD §15) |
| Frontier generator | Anthropic Messages API | Claude Opus, Phase 2 comparison arm |
| Validation | zod 4 | Shared between request parsing and corpus schemas |
| Tests | Vitest 4 | No linter configured — `typecheck` is the gate |

Hono was chosen because it builds on the Web `fetch` API rather than Node-specific
APIs, which kept `createApp()` environment-agnostic. The Cloudflare Worker deployment
target that property was meant to enable has since been abandoned in favour of a
Node-only backend (PRD §15); the DI boundary remains, but there is currently only one
environment.

## 2. Repository layout

```
apps/
  backend/          Hono API — routes, dependency wiring, Node entrypoint
  frontend/         React + Vite SPA — ask view + results dashboard
packages/
  core/             Experiment logic: chunkers, metrics, prompt, schemas, constants
  shared/           API contract types + presentation helpers (theme, format, scales)
  ui/               Presentational React components incl. hand-rolled visualisations
corpus/             Archival source PDFs (the pipeline never parses these)
docs/               PRD, proposal, plans, this document
```

Workspace names: `backend`, `frontend`, `@tos-rag/core`, `@tos-rag/shared`, `@tos-rag/ui`.

### Source-only packages

`core`, `shared`, and `ui` have no build step. Their `main`/`exports` point directly at
`src/index.ts`, and consumers compile them through `moduleResolution: "bundler"`. Two
consequences worth respecting:

- Do not add `dist/` output or a compile step to these packages.
- Do not import from deep paths (`@tos-rag/core/src/metrics/squad`). Extend the
  package's `src/index.ts` barrel instead — the barrel is the public surface.

## 3. Dependency injection is the central pattern

`apps/backend/src/app.ts` exports `createApp(deps: AppDeps)`. Routes never construct a
database client, never read `process.env`, and never call `fetch` directly. Everything
environmental arrives through the `AppDeps` interface:

```ts
export interface AppDeps {
  retrieve: (question: string, opts?: RetrieveOptions) => Promise<RetrievedChunk[]>;
  generate: (prompt: string, model: GeneratorModel) => Promise<GenerationResult>;
  getAnalysisResults: () => Promise<AnalysisRow[]>;
  winningConfig: { strategy: Strategy; chunkSize: number };
}
```

This buys two things:

1. **A clean deps boundary.** Routes never construct clients directly; only the deps
   module differs between production and tests. (The Cloudflare Worker deployment
   target this was meant to also enable has been abandoned — the backend is Node-only,
   PRD §15.)
2. **Hermetic tests.** `apps/backend/test/app.test.ts` injects plain fakes into
   `createApp` — no network, no database, no fixtures directory.

The offline demo deps (`deps/demo.ts`) that used to provide a credential-free fallback
have been removed; the backend now requires `DATABASE_URL` and serves the real
pipeline only (PRD §15).

### The live implementation

**`deps/live.ts`** — the real (and now only) pipeline.

- Embeds the question through the local ONNX embedder (`MODEL_IDS.embedderLocal`).
- Calls the `match_chunks(p_config_id, p_query, p_k, p_doc_id)` RPC — through the
  `@tos-rag/db` Prisma client (the `matchChunks` raw-SQL helper), since `chunks.embedding`
  is an `Unsupported("vector(768)")` column — which does an
  **exact** pgvector scan filtered by config. Exact rather than approximate (HNSW/IVF)
  because the corpus is only a few thousand rows per config, and exact scan gives
  perfect recall deterministically — an ANN index would introduce a confound the
  experiment does not want to measure (PRD §8.4).
- Generates via a local Ollama server (Llama 3.1 8B, `/api/generate`, PRD §15) or the
  Anthropic Messages API (Opus).
- Resolves `(strategy, chunkSize)` to a `configs.id`, memoised in a `Map` for the
  process lifetime. A config that has not been ingested yet surfaces as a clear error
  rather than an empty result set.

`server.ts` requires `DATABASE_URL` and serves the real pipeline only — it fails fast at
boot without it (PRD §15). (`DATABASE_URL` points the shared Prisma client at Postgres —
the local Supabase stack at `127.0.0.1:54322`, or a hosted Supabase project.)

The same injection style runs through `packages/core`: chunkers accept
`countTokens: TokenCounter` and (for `semantic`) `embed: EmbedFn` as options rather than
importing a tokenizer or an HTTP client. That is why every core test is fast and offline.

## 4. Request flow

```mermaid
sequenceDiagram
    participant U as Browser (React)
    participant A as Hono /api/ask
    participant C as packages/core
    participant S as Supabase (pgvector)
    participant AI as Ollama / Anthropic

    U->>A: POST /api/ask { question, docId?, strategy?, chunkSize?, model? }
    A->>A: zod parse; fill omitted fields from winningConfig
    A->>AI: embed(question)
    A->>S: match_chunks(config_id, embedding, k=8)
    S-->>A: top-k chunks with char offsets
    A->>C: buildRagPrompt(question, evidence)
    A->>AI: generate(prompt) — temp 0, seed 42, max_tokens 1024
    AI-->>A: answer + token usage
    A-->>U: { answer, abstained, evidence, config, model, timings, tokens }
```

Retrieval and generation are timed separately (`timings.retrievalMs`,
`timings.generationMs`) because the PRD reports them as distinct latency distributions.
Abstention is detected by `isAbstention()` in `packages/core` — one definition shared by
the demo and the offline evaluation, so the demo's abstention badge and the reported
abstention rate can never drift apart.

Pipeline failures return **503** with the underlying message rather than 500. The
frontend surfaces that message directly, which is what makes "config not ingested yet"
and "Opus key missing" actionable instead of opaque.

## 5. API surface

| Route | Status | Purpose |
| --- | --- | --- |
| `GET /api/health` | implemented | Liveness probe |
| `POST /api/ask` | implemented | The demo's RAG endpoint |
| `GET /api/results` | implemented | Serves rows from `analysis_results` verbatim |
| `POST /api/experiment/run-one` | **not implemented** | Single experimental run (PRD §7) |
| `POST /admin/ingest` | **not implemented** | Chunk + embed one config (PRD §8) |

`/api/ask` accepts the three experimental variables as optional overrides — chunking
strategy (5 values), chunk size (128/256/512), and generator (`llama` / `opus`) —
defaulting to the winning config plus Llama. This is the "pipeline bench" amendment
(PRD §13, 2026-07-18): visitors can feel the effect of the variables the study measures.
The frozen constants (k, embedder, prompt, temperature, seed) are **not** exposed.

`/api/results` deliberately does no computation. It returns `{ analysis, payload }` rows
and the dashboard formats them. See §7.

## 6. Data model

Postgres + pgvector, defined in PRD §9. The tables and their roles:

| Table | Role |
| --- | --- |
| `documents` | Canonical text + `sha256`, so every span is traceable to a frozen file |
| `configs` | The 15 (strategy × chunk size) cells of the Phase 1 sweep |
| `chunks` | `vector(768)` embeddings plus `char_start` / `char_end` per config |
| `questions` | Q&A set with gold clause spans and question types |
| `runs` | One row per (question, config, model) execution — answer, tokens, latency |
| `evals` | Deterministic metrics computed over `runs` |
| `analysis_results` | Aggregates and statistics produced by the analysis step |

Every number that appears in the report must be traceable back to a row here. The
`chunks` table stores character offsets rather than only text precisely so retrieval
quality can be scored against gold spans by character overlap.

## 7. Invariants worth protecting

These are load-bearing. Breaking one silently invalidates collected data.

**The chunker offset invariant.**

```
chunk.text === canonical.slice(chunk.charStart, chunk.charEnd)
```

Every chunker must preserve exact character offsets — no trimming, no whitespace
normalisation, no dropped characters. All gold clause spans and all retrieval metrics
are character offsets into the canonical document, so an off-by-one in a chunker
corrupts precision/recall for every question that touches that region.
`assertOffsetInvariant` in `packages/core` exists to enforce this, and it is the reason
the five chunkers are hand-rolled rather than delegated to off-the-shelf splitters,
which routinely trim.

**Frozen experiment constants.** k = 8, temperature 0, seed 42, `max_tokens` 1024, chunk
sizes 128/256/512, zero overlap, one fixed prompt template. These live in
`packages/core/src/schemas.ts` as constants, not configuration. They are experimental
controls: changing one invalidates every run collected so far and requires a PRD
amendment. The explicit `max_tokens` matters especially — generator API defaults are
often much lower than 1024 and would truncate answers silently, showing up as a
spurious quality difference.

**No inferential statistics in TypeScript.** Wilcoxon tests, bootstrap confidence
intervals, and multiple-comparison correction belong to the planned Python `analysis/`
step (PRD §11). The dashboard formats what `/api/results` returns and computes nothing.
Keeping statistics in one place, in a language with vetted implementations, is what
makes the reported numbers defensible.

## 8. Frontend

`apps/frontend` is a React 19 + Vite SPA with two views selected by hash routing
(`#/` ask, `#/results` dashboard) — a `hashchange` listener in `App.tsx`, no router
dependency. The dashboard is `lazy()`-loaded, so the ask view (the common entry point)
does not pay for the visualisation code.

All network access is funnelled through `src/lib/api.ts`. Views never call `fetch`
themselves, which keeps error handling and the response contract in one place. In
development, Vite proxies `/api` to `localhost:3000`, so the frontend uses same-origin
relative URLs in every environment and no base-URL configuration is needed.

Presentation splits three ways:

- `packages/shared` — types both sides agree on (`AskResponse`, `Evidence`,
  `PipelineConfig`) plus pure helpers: theme resolution, number formatting, scales,
  citation building. The API contract lives here so backend and frontend cannot drift.
- `packages/ui` — presentational components, including the hand-rolled visualisations
  (`Heatmap`, `FactorBars`, `LatencyBoxes`). No data fetching, no charting library.
- `apps/frontend` — routing, state, data loading, composition.

Theme is stored in `localStorage` under `tos-rag-theme` and applied as
`document.documentElement.dataset.theme`, falling back to the OS preference. Every
`localStorage` access is wrapped in `try`/`catch` because it throws in private-browsing
modes.

## 9. Commands

```bash
pnpm dev          # backend (tsx watch, :3000) + frontend (vite, :5173, /api proxied)
pnpm test         # vitest run across packages defining a test script
pnpm typecheck    # tsc --noEmit everywhere — the gate, since there is no linter
pnpm build        # currently only the frontend produces output
```

Per-workspace:

```bash
pnpm --filter @tos-rag/core test
pnpm --filter @tos-rag/core exec vitest run test/chunkers.test.ts
pnpm --filter @tos-rag/core exec vitest run -t "offset invariant"
```

### Environment variables

| Variable | Required for | Effect if absent |
| --- | --- | --- |
| `DATABASE_URL` | boot | Backend throws and refuses to start; Postgres for the Prisma client (local Supabase stack or hosted project) |
| `OLLAMA_URL` | Llama generator | Defaults to `http://localhost:11434` |
| `OLLAMA_MODEL` | Llama generator | Defaults to `llama3.1:8b` |
| `ANTHROPIC_API_KEY` | Opus generator | Opus requests return a 503 explaining the gap |
| `WINNING_CONFIG_ID` | live default config | Defaults to `"1"` |
| `PORT` | Node server | Defaults to `3000` |

## 10. Known divergences from the PRD

The PRD is the spec; the repository has moved ahead of it in places. Current gaps:

- The PRD names `apps/web` and a single `packages/core`. The frontend has since split
  into `apps/frontend` + `packages/shared` + `packages/ui`.
- `analysis/` (Python) and `corpus/questions/` do not exist yet. `corpus/canonical/`
  now exists and holds two frozen canonicals, `github-tos.md` and `netflix-tou.md`;
  the PDFs in `corpus/` remain archival and the pipeline never parses them.
- `POST /api/experiment/run-one` and `POST /admin/ingest` are not implemented.
- Deployment is Node-only (`@hono/node-server`). The Cloudflare Worker target described
  in PRD §3 — `wrangler`, the `env.AI` binding, static assets — has been abandoned
  (PRD §15): the ~1.2 GB local ONNX embedder cannot run in a Worker.
