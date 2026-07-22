# `@tos-rag/db` — shared database package (Prisma-owned schema, Supabase local stack)

**Date:** 2026-07-21
**Status:** Approved (pending spec review)

## Goal

Consolidate all database concerns into a single shared workspace package,
`packages/db` (`@tos-rag/db`), that the backend (and future `analysis/` step)
depend on. Prisma becomes the source of truth for the schema and migrations;
the Supabase CLI provides the local Postgres/Studio container stack only.

## Decisions (locked)

1. **Prisma owns the schema + migrations.** `prisma/schema.prisma` is the
   source of truth. The three hand-written SQL migrations
   (`0001_extensions`, `0002_schema`, `0003_seed_configs`) are **retired** —
   their content is preserved verbatim inside the Prisma init migration and the
   seed script.
2. **Prisma drives, Supabase = stack only.** `supabase start` provides
   containers; `DATABASE_URL` points at the local Supabase Postgres
   (`127.0.0.1:54322`) and `prisma migrate dev` applies all schema. We stop
   using `supabase db reset`; the reset path is `prisma migrate reset` +
   `prisma db seed`.
3. **Backend runtime switches off `@supabase/supabase-js` to Prisma.**
   `deps/live.ts` and `scripts/ingest.ts` read/write through the shared Prisma
   client. Vector-touching operations use raw SQL (Prisma cannot model
   `vector` columns or SQL functions).
4. **`supabase/` moves into `packages/db/supabase`.** The package is
   self-contained; Supabase CLI commands run with the package as cwd.

### Why Prisma-only at runtime is acceptable here

The PRD's Cloudflare Worker portability goal is **already** void: CLAUDE.md /
PRD §15 log the backend as Node-only because the local ONNX embedder must run
in-process. Prisma being Node-only (absent Accelerate/Data Proxy) therefore
loses nothing that isn't already lost. This is recorded so the deviation stays
traceable.

## Package layout

```
packages/db/
├── package.json          # @tos-rag/db; source-only barrel; postinstall: prisma generate
├── prisma/
│   ├── schema.prisma      # SOURCE OF TRUTH
│   ├── migrations/        # prisma-generated, hand-edited for pgvector/RPC/RLS/CHECKs
│   └── seed.ts            # the 15 configs (replaces 0003_seed_configs.sql)
├── supabase/              # moved from repo root — config.toml + local stack
│   └── config.toml
├── src/
│   ├── client.ts          # PrismaClient singleton
│   ├── vector.ts          # raw-SQL helpers: matchChunks(), insertChunks()
│   └── index.ts           # barrel: exports `prisma`, generated types, helpers
└── .env.example           # DATABASE_URL (local + prod notes)
```

The repo's packages are source-only (no `dist`), and that holds for the
hand-written `src/`. The **exception** is Prisma's generated client, which is a
genuine build artifact: it generates to the default `node_modules/.prisma`
location (nothing compiled lands in `src/`), and a `postinstall: prisma
generate` script makes a fresh clone work.

## Schema (`schema.prisma`)

Mirrors `0002_schema.sql` exactly — every table becomes a model with identical
columns, primary keys, foreign keys, and unique constraints:
`documents`, `configs`, `chunks`, `questions`, `runs`, `evals`,
`analysis_results`.

Two categories Prisma cannot express go into hand-edited migration SQL
(via `prisma migrate dev --create-only`, then applied):

- **`chunks.embedding`** → `Unsupported("vector(768)")`. `prisma migrate` still
  emits `vector(768) NOT NULL` in the migration SQL, so the column is created
  correctly; it just cannot be read/written through the model API.
- **Raw-SQL objects preserved verbatim from the current migrations:**
  `create extension if not exists vector`, the `match_chunks(...)` function
  body (exact-scan, no index — an experimental control), and the
  `enable row level security` statements on all seven tables.
- **CHECK constraints** (`strategy in (...)`, `chunk_size in (128,256,512)`,
  `qtype in (...)`, `phase in (1,2)`, `crag_score in (-1,0,1)`) are added as
  raw SQL in the same migration, since Prisma migrate does not emit CHECKs.

## `src/vector.ts` — the pgvector escape hatch

Because `embedding` is `Unsupported`, the two vector-touching operations use
raw SQL through Prisma:

- **`matchChunks(configId, queryVector, k, docId)`** → `prisma.$queryRaw`
  calling `match_chunks(...::vector, ...)`, returning typed rows. Same
  exact-scan RPC, same k, invoked through Prisma instead of `supabase.rpc`. The
  query vector is passed as a `'[...]'::vector` literal parameter.
- **`insertChunks(rows)`** → `prisma.$executeRaw` batched multi-row insert
  building `'[...]'::vector` literals, because an `Unsupported` column cannot be
  written via `prisma.chunks.create`. Batch size preserved (200).

Everything non-vector (`configs`, `documents`, `analysis_results`) uses the
normal typed Prisma model API.

## Supabase local stack

- `supabase/` moves into `packages/db/`; commands run with the package as cwd
  (`pnpm --filter @tos-rag/db exec supabase start`).
- `supabase` added as a devDependency of `@tos-rag/db` (its postinstall fetches
  the CLI binary; `allowBuilds: supabase: true` already permits this).
- `supabase/migrations/` is retired. Schema reaches the local DB via
  `prisma migrate dev`; seed via `prisma db seed`.
- `.gitignore` for `.branches`/`.temp`/`.env*.local` carries over to the new
  location.

## Backend changes

- **`apps/backend/src/deps/live.ts`**: drop `createClient`; import `prisma` and
  the helpers from `@tos-rag/db`.
  - `resolveConfigId` → `prisma.configs.findUnique({ where: { strategy_chunkSize: {...} } })`
  - `retrieve` → `matchChunks(configId, vector, RETRIEVAL_K, docId)`
  - `getAnalysisResults` → `prisma.analysisResults.findMany(...)`
  - `LiveEnv` drops `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; generation
    (CF/Anthropic) is untouched.
- **`apps/backend/src/scripts/ingest.ts`**:
  - `documents.upsert` → `prisma.documents.upsert`
  - config resolution → Prisma
  - `writeChunks` delete → `prisma.chunks.deleteMany`; insert → `insertChunks()`
  - `--dry-run` still needs no DB connection.
- **`apps/backend/src/server.ts`**: the live-vs-demo gate keys on `DATABASE_URL`
  (+ `CF_ACCOUNT_ID`/`CF_API_TOKEN`) instead of the Supabase pair. Startup log
  line preserved.
- **`apps/backend/package.json`**: remove `@supabase/supabase-js`; add
  `@tos-rag/db`.
- **`apps/backend/.env.example`**: replace `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` with `DATABASE_URL` (local default +
  production/Supabase pooled-connection note).

## Explicitly unchanged (experimental controls)

Frozen constants (k=8, temp 0, seed 42, max_tokens 1024, chunk sizes
128/256/512, zero overlap, fixed prompt), the exact-scan / no-HNSW decision,
the character-offset invariant, the `match_chunks` SQL body, and the RLS
posture all carry over byte-for-byte. This is a plumbing change; numbers stay
traceable to rows.

## Testing / acceptance

- `pnpm --filter @tos-rag/db exec supabase start` brings up the stack.
- `prisma migrate reset` + `prisma db seed` produces a schema identical to the
  retired SQL migrations (same tables, `match_chunks`, RLS, 15 config rows).
- `pnpm ingest -- --doc github-tos --dry-run` still runs with no DB.
- `pnpm ingest -- --doc github-tos --strategy sentence --size 256` writes
  chunks (embeddings included) via `insertChunks`.
- `/api/ask` returns the same shape; retrieval goes through `matchChunks`.
- `pnpm typecheck` (the repo's gate) passes across all workspaces.
- Existing backend tests (`createApp` with fake deps) remain green — routes are
  unchanged.

## Out of scope

- The Python `analysis/` step (future consumer; the package is designed to be
  importable by it but nothing is built for it now).
- Any change to chunkers, metrics, prompts, or the generation path.
- Production Supabase provisioning (only `DATABASE_URL` wiring is documented).
