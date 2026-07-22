# Real RAG ask + remove Cloudflare — Design

**Date:** 2026-07-22
**Status:** Approved (pending spec review)

## Goal

Make `/api/ask` retrieve from the real ingested chunks in the Supabase (Docker)
vector database, over both corpus documents, and remove Cloudflare from the
stack. Llama generation moves from Cloudflare Workers AI to a local **Ollama**
runtime; the backend becomes Node-only (no Cloudflare Worker path).

## Context: what already exists (no work needed)

- **Ingestion pipeline** (`pnpm ingest`): chunks → embeds with the local ONNX
  EmbeddingGemma model → writes to the `chunks` table. Idempotent per
  `(config, doc)`. Asserts the offset invariant and full tiling before any I/O.
- **Query-time retrieval** (`deps/live.ts`): `embedQuery(question)` →
  `matchChunks(configId, vector, k=8, docId)` pgvector exact-scan.
- **Strategy + chunk-size selection**: already flows through `AskSchema` and
  into `retrieve`.
- **Supabase Docker stack**: running; Postgres on `127.0.0.1:54322`.

The reason ask does not hit real chunks *today* is the boot-time gate in
`server.ts`: it requires `DATABASE_URL && CF_ACCOUNT_ID && CF_API_TOKEN`. With no
Cloudflare creds it silently falls back to demo deps. Removing Cloudflare and the
demo fallback fixes this.

## Decisions (from brainstorming)

1. **Llama generator → Ollama** (local, `http://localhost:11434`). Opus via the
   Anthropic Messages API is unchanged. Same experimental model (Llama 3.1 8B);
   only the serving runtime changes.
2. **Both documents** in scope: GitHub (canonical already frozen) and Netflix.
3. **Netflix canonical source → the committed PDF** (`corpus/Netflix Terms of
   Use.pdf`), a one-time extraction → hand-clean → freeze. The runtime pipeline
   still never parses PDFs.
4. **Remove the demo deps entirely.** No offline fallback. If `DATABASE_URL` is
   unset the backend fails fast at boot with a clear message.

## Part A — Remove Cloudflare, add Ollama

**`apps/backend/src/deps/live.ts`**
- Replace `runAi` / Workers-AI Llama call with an Ollama call:
  `POST ${OLLAMA_URL}/api/generate`, body
  `{ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0, seed: GENERATION_SEED, num_predict: GENERATION_MAX_TOKENS } }`.
  Map the response: `answer = json.response.trim()`, token counts from
  `json.prompt_eval_count` / `json.eval_count` (fall back to 0), `latencyMs`
  measured locally. On non-OK, throw a message naming Ollama and the URL.
- `generateOpus` unchanged.
- `LiveEnv`: drop `CF_ACCOUNT_ID`, `CF_API_TOKEN`; add `OLLAMA_URL`,
  `OLLAMA_MODEL`. Keep optional `ANTHROPIC_API_KEY`.

**`apps/backend/src/server.ts`**
- Gate becomes `const live = !!DATABASE_URL`. If unset, throw at boot:
  `"DATABASE_URL is required — the backend serves the real pipeline only. See apps/backend/.env.example."`
- Drop `CF_*` env reads; add `OLLAMA_URL` (default `http://localhost:11434`),
  `OLLAMA_MODEL` (default `llama3.1:8b`). Pass them into `createLiveDeps`.
- Startup log keeps naming the active embedder.

**`apps/backend/src/adapters/`**
- Delete `embedder.cf.ts`.
- `index.ts`: `createEmbedder` always returns the local embedder; `EmbedderEnv`
  loses `CF_*`; remove the `createCfEmbedder` export.
- Delete the Cloudflare parity live test if present
  (`test/embedder.parity.live.test.ts`).

**`packages/core/src/schemas.ts` (+ `index.ts` barrel)**
- `MODEL_IDS.llama` → `"llama3.1:8b"` (Ollama tag).
- Remove now-unused Cloudflare-only constants: `MODEL_IDS.embedder` (the local
  embedder uses `MODEL_IDS.embedderLocal`) and `EMBED_MAX_TOKENS_CF`, plus their
  `index.ts` re-exports.
- **Keep `EMBED_BATCH_MAX`** — `embedder.local.ts` uses it as its forward-pass
  batch guard.

**`apps/backend/src/deps/demo.ts`** — delete. Remove its import in `server.ts`.

**Tests / env**
- `test/embedder.test.ts`: remove the `createCfEmbedder` describe block; keep the
  local-embedder and prefix tests.
- `.env.example` / `.dev.vars`: drop `CF_*`; add
  `OLLAMA_URL=http://localhost:11434`, `OLLAMA_MODEL=llama3.1:8b`; keep
  `DATABASE_URL`, `ANTHROPIC_API_KEY`. Update the header comment (real pipeline
  requires `DATABASE_URL`; Ollama for Llama, Anthropic key for Opus).

**Docs**
- CLAUDE.md + `docs/architecture.md`: Node-only backend; no Worker path; Ollama
  is the Llama runtime; demo deps removed.
- Log the deviations in PRD §15: Cloudflare/Worker path abandoned; Llama served
  via Ollama; demo fallback removed.

## Part B — Both documents into the vector DB

- **GitHub**: `corpus/canonical/github-tos.md` already frozen — ingest as-is.
- **Netflix** (one-time canonical build):
  1. Extract text from `corpus/Netflix Terms of Use.pdf`.
  2. Hand-clean to markdown; record cleaning decisions in
     `corpus/canonical/CHANGELOG.md`.
  3. `normalizeCanonical` → write `corpus/canonical/netflix-tou.md`.
  4. Freeze: add to `manifest.json` (title, sha256, version 1, charLength in
     UTF-16 code units) and regenerate `checksums.txt`.
- **Seed + ingest** against the running Docker DB:
  - Ensure the Prisma migration is applied and `prisma db seed` has populated the
    15 `configs` rows.
  - Smoke test: `pnpm ingest -- --doc github-tos --strategy sentence --size 256`.
  - Full sweep: `pnpm ingest -- --doc github-tos --all-configs` and
    `pnpm ingest -- --doc netflix-tou --all-configs` (15 configs × 2 docs).

## Part C — Query flow (already built)

No code change beyond Part A. Clarification for the mental model: the **question
is embedded into a single query vector, not chunked** — chunking is a
document-indexing concern only. Strategy + chunk-size selection already routes to
the right `configs` row.

## Out of scope

Gold-span annotation, the `runs`/`evals` experiment harness, and the Python
`analysis/` step. None are required for ask to retrieve from real chunks.

## Verification

- `pnpm typecheck` and `pnpm test` pass (no Cloudflare/demo references remain).
- `grep -rniE 'cloudflare|CF_ACCOUNT|CF_API|workers.?ai'` over `src`/`docs`
  returns only historical/PRD-deviation notes.
- Backend boots with `DATABASE_URL` set and logs `live, embedder …`.
- `POST /api/ask` returns evidence whose `text` matches
  `canonical.slice(charStart, charEnd)` for the selected config, for both docs.
- Ollama path returns a non-empty answer for `model: "llama"`; Opus path returns
  one for `model: "opus"` when `ANTHROPIC_API_KEY` is set.
