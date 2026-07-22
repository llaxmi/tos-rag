# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tos-rag` is a final-year research project: a **controlled experiment on RAG pipeline design** over Terms of Service documents, plus a public demo of the resulting pipeline. `docs/PRD.md` is the authoritative spec — it defines the experimental design, data model, metrics, and acceptance criteria. Read the relevant PRD section before changing pipeline behavior; source comments cite PRD sections (`PRD §8.3`) and those references should be kept accurate.

Two phases: Phase 1 sweeps 5 chunking strategies × 3 chunk sizes (15 configs) with a fixed generator; Phase 2 compares Llama 3.1 8B vs Claude Opus 4.8 under the winning config. Numbers that end up in the report must be traceable to database rows.

## Commands

```bash
pnpm dev          # turbo: backend (tsx watch, :3000) + frontend (vite, :5173, /api proxied to :3000)
pnpm test         # turbo: vitest run across packages that define a test script
pnpm typecheck    # turbo: tsc --noEmit everywhere
pnpm build        # turbo: currently only the frontend produces output

pnpm fetch-canonical github-tos                 # refresh corpus/canonical/<doc>.md (see freeze protocol)
pnpm ingest -- --doc github-tos --strategy sentence --size 256
pnpm ingest -- --doc github-tos --all-configs   # the 15-config Phase 1 sweep
pnpm ingest -- --dry-run ...                    # chunk + embed + assert, write nothing, no DB needed
pnpm --filter backend test:live                 # non-hermetic: loads the real embedder (~1.2GB)
```

`ingest` is deliberately **not** a turbo task — it is a side-effecting one-shot, and a cached
run that silently no-ops would be a footgun. Note the `--` before flags: pnpm needs it to pass
them through.

Per-workspace (run from that directory, or `pnpm --filter <name> <script>`):

```bash
pnpm --filter @tos-rag/core test              # core unit tests only
pnpm --filter @tos-rag/core exec vitest run test/chunkers.test.ts   # one file
pnpm --filter @tos-rag/core exec vitest run -t "offset invariant"   # one test by name
pnpm --filter @tos-rag/core test:watch
```

Workspaces: `backend`, `frontend`, `@tos-rag/core`, `@tos-rag/shared`, `@tos-rag/ui`, `@tos-rag/db`. There is no linter configured; `typecheck` is the gate.

## Architecture

### Dependency injection is the central pattern

`apps/backend/src/app.ts` exports `createApp(deps: AppDeps)` — routes are pure and environment-agnostic. The backend is Node-only (see Known divergences); `AppDeps` has one implementation:

- `deps/live.ts` — real pipeline: pgvector exact-scan retrieval via the `@tos-rag/db` Prisma client (`matchChunks` raw-SQL helper over the same exact-scan `match_chunks` RPC), embedding via the injected `Embedder`, Llama generation via a local Ollama server (`/api/generate`), Opus via the Anthropic Messages API. Takes the embedder as a constructor argument so the ONNX model loads once at boot rather than per request.

`server.ts` requires `DATABASE_URL` and serves the real pipeline only — it fails fast at boot without it. The demo fallback has been removed. Tests inject fake deps directly into `createApp`.

The same injection style runs through `packages/core`: chunkers take `countTokens: TokenCounter` and (for `semantic`) `embed: EmbedFn` as options rather than importing a tokenizer or HTTP client, which keeps every core test hermetic and fast.

### Package boundaries

- **`packages/core`** — the experiment's logic, shared by the backend and (per the PRD) local scripts: the 5 chunkers, deterministic metrics (char-span precision/recall, SQuAD F1/EM, cosine), the fixed RAG prompt, zod schemas, and the frozen experiment constants (`RETRIEVAL_K`, `GENERATION_SEED`, `GENERATION_MAX_TOKENS`, `MODEL_IDS`, `CHUNK_SIZES`). No React, no I/O.
- **`packages/shared`** — API contract types (`AskResponse`, `Evidence`, `PipelineConfig`) plus presentation-only helpers (theme, formatting, scales, citations). Backend and frontend both mean the same thing by these types.
- **`packages/ui`** — presentational React components. Two kinds: `src/primitives/` holds shadcn/ui source (themed, shadows stripped), and the top level holds tos-rag's own components — `CutMark` plus the hand-rolled visualizations (heatmap, contact sheet, factor bars, latency boxes), which have no shadcn equivalent and stay hand-rolled. No data fetching.
- **`apps/frontend`** — React 19 + Vite SPA, hash routing (`#/` ask, `#/results` dashboard), all network access funneled through `src/lib/api.ts`.

### Styling: Tailwind v4 + shadcn/ui

`docs/design.md` is the authoritative design spec — read it before changing visual behavior. Points that bite:

- **Tokens live in `apps/frontend/src/styles.css`** and are re-exported as Tailwind utilities via `@theme inline`. Components use utilities (`bg-compare`, `text-ink-soft`), never raw hex.
- **`--accent` is shadcn's hover surface, not a brand colour.** Our amber is `--compare`.
- **`@source "../../../packages/ui/src"`** in `styles.css` is what makes Tailwind scan the UI package. Remove it and every utility used inside `packages/ui` silently fails to generate.
- **shadcn primitives live in `packages/ui`, not the app**, so `packages/ui` components can build on them without importing upward. The CLI can't write there — see the add-a-component recipe in `docs/design.md`.
- Palette changes must be re-checked against WCAG AA; `--seq-4` in particular sits off the even ramp curve for a documented contrast reason.

Packages are **source-only**: `main`/`exports` point at `src/index.ts` and consumers compile them via `moduleResolution: "bundler"`. There is no build step for `core`/`shared`/`ui` — do not add `dist` output or import from deep paths; extend the package's `src/index.ts` barrel instead.

### Invariants worth protecting

- **Chunker offset invariant**: `chunk.text === canonical.slice(chunk.charStart, chunk.charEnd)`. Every chunker must preserve exact character offsets — no trimming — because all gold clause spans and retrieval metrics are character offsets into the canonical document. `assertOffsetInvariant` exists for this; it is why the chunkers are hand-rolled rather than delegated to LangChain splitters.
- **Frozen experiment constants**: k = 8, temperature 0, seed 42, `max_tokens` 1024, chunk sizes 128/256/512, zero overlap, one fixed prompt template. These are experimental controls, not tunables — changing one invalidates collected runs and needs a PRD amendment.
- **No inferential statistics in TypeScript.** Wilcoxon/bootstrap/multiple-comparison correction belong to the planned Python `analysis/` step (PRD §11); the dashboard only formats what `/api/results` returns.
- **Embedding prefixes are asymmetric and must never be persisted.** EmbeddingGemma is trained with `"task: search result | query: "` for queries and `"title: none | text: "` for documents (trailing spaces significant — they live in `EMBED_PREFIXES` in `packages/core`). Using the wrong one degrades retrieval with *no error and no symptom* beyond mediocre results. This is enforced structurally: `Embedder` exposes only `embedQuery`/`embedDocuments`, never a raw `embed`. The prefix is applied to the string handed to the model only — prefixing `chunks.text` would break the offset invariant.
- **Never mix embedders across ingest and query.** Chunks indexed with one model/dtype and queried with another are not guaranteed to share a vector space. `local` is the only supported `EMBEDDER` value now that Cloudflare is removed (see Known divergences).

### The ingestion path

`corpus/canonical/<doc_id>.md` is the anchor for everything: every chunk boundary and gold clause
span is a character offset into that exact text, in **UTF-16 code units** (`String.length`, what
`slice` uses — Postgres `length()` counts codepoints and will disagree). `manifest.json` records
each document's sha256 and `loadCanonical` refuses to return a document that has drifted, because
that drift silently invalidates every span annotated against it (PRD §5 freeze protocol).
`checksums.txt` is generated from the manifest for `shasum -c`.

`src/scripts/plan-ingest.ts` holds the pure half — canonical text in, rows out — so the part that
must be correct is testable with fakes and no model, network, or DB. It asserts the offset
invariant *and* full tiling before any I/O: `assertOffsetInvariant` alone would pass a chunker
that silently dropped a section, and a dropped section is unretrievable without ever erroring.

Migrations are Prisma-owned, living in `packages/db/prisma/migrations` and applied by
`prisma migrate dev`; the Supabase CLI provides the local Postgres stack only and lives at
`packages/db/supabase`. `configs` must be seeded before ingest — seeded by `prisma db seed`
(`packages/db/prisma/seed.ts`) — and `resolveConfigId` resolves by `(strategy, chunk_size)` and
never by hardcoded id. The backend talks to Postgres through Prisma (`@tos-rag/db`), which makes
it Prisma/Node-only for now — see Known divergences below.

**Promotion trigger:** the embedder adapter sits in `apps/backend/src/adapters/` because the
backend is its only consumer. If the planned `analysis/` step or a second app needs it, move
`embedder.local.ts` to a `packages/embedding` workspace verbatim.

### Known divergences from the PRD

The PRD's layout names `apps/web` and a single `packages/core`; the repo has since split the frontend into `apps/frontend` + `packages/shared` + `packages/ui`. The `analysis/` (Python) directory and `corpus/questions/` do not exist yet, and `corpus/canonical/` now holds two frozen canonicals, `github-tos.md` and `netflix-tou.md` (netflix-tou frozen from the committed PDF). The PDFs in `corpus/` remain archival; the pipeline never parses them. Backend routes `/api/experiment/run-one` and `/admin/ingest` are still unimplemented (ingestion runs as a local script instead); `/api/ask`, `/api/results`, and `/api/health` exist. See PRD §15 for the logged deviations, notably the local embedder and the resulting Node-only backend.

Cloudflare is fully removed — no Worker deployment path, no `EMBEDDER=cf`. Llama is served by local Ollama (`OLLAMA_URL`/`OLLAMA_MODEL`). The offline demo deps were removed; the backend now requires `DATABASE_URL`.
