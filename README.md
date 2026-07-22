# tos-rag

A controlled experiment on **RAG pipeline design over Terms-of-Service documents**, plus a public demo of the resulting pipeline. Phase 1 sweeps 5 chunking strategies × 3 chunk sizes (15 configs) with a fixed generator; Phase 2 compares Llama 3.1 8B vs Claude Opus 4.8 under the winning config.

- `docs/PRD.md` — the authoritative spec (experimental design, data model, metrics, acceptance criteria).
- `docs/architecture.md` — how the pieces fit together.
- `docs/design.md` — the frontend/visual design spec.
- `CLAUDE.md` — orientation for the codebase and its invariants.

This README covers **getting the project running on a fresh machine**.

---

## Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| **Node.js ≥ 20** (22 LTS recommended) | Runs the backend, scripts, and Vite | [nodejs.org](https://nodejs.org) |
| **pnpm 11.12.0** | Workspace package manager (pinned in `package.json`) | `corepack enable` (ships with Node) |
| **Docker** | Runs the local Supabase Postgres stack (pgvector) | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Ollama** | Serves the open generator arm, Llama 3.1 8B | `brew install ollama` |
| Anthropic API key | *Optional* — enables the Opus generator arm (Phase 2) | [console.anthropic.com](https://console.anthropic.com) |

> **Heads-up: first ingest/query downloads ~1.2 GB.** Embeddings run
> `embeddinggemma-300m` locally via ONNX; the weights are fetched from Hugging
> Face on first use and cached under your home directory.

Enable pnpm via Corepack (once):

```bash
corepack enable
corepack prepare pnpm@11.12.0 --activate
```

---

## Setup

### 1. Install dependencies

```bash
pnpm install
```

This also runs `prisma generate` (via the db package's `postinstall`) so the
Prisma client is ready.

### 2. Configure environment

Two `.env` files are needed — one for the backend runtime, one for the Prisma
CLI. The committed `.env.example` files use the local Supabase defaults, so
copying them as-is works out of the box:

```bash
cp apps/backend/.env.example apps/backend/.env
cp packages/db/.env.example   packages/db/.env
```

Then edit `apps/backend/.env` if you want the Opus arm:

```dotenv
# apps/backend/.env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
ANTHROPIC_API_KEY=           # optional — leave blank to skip the Opus arm
EMBEDDER=local               # only supported value
EMBEDDER_DTYPE=fp32          # fp32 | q8 | q4  (NOT fp16)
```

### 3. Start Postgres and apply the schema

The local Supabase stack provides Postgres + pgvector (needs Docker running).
Migrations and the config seed are **Prisma-owned**:

```bash
pnpm --filter @tos-rag/db db:start   # supabase start (Docker) → Postgres on :54322
pnpm --filter @tos-rag/db migrate    # prisma migrate dev — creates the 7 tables + match_chunks RPC
pnpm --filter @tos-rag/db seed       # prisma db seed — seeds the 15 chunking configs
```

Verify the configs seeded (expect **15**):

```bash
pnpm --filter @tos-rag/db studio     # Prisma Studio → configs table
```

Stop the stack later with `pnpm --filter @tos-rag/db db:stop`.

### 4. Start Ollama and pull Llama

```bash
ollama serve            # or run the Ollama.app; skip if it already runs as a service
ollama pull llama3.1:8b
```

### 5. Ingest a corpus into the database

The canonical documents (`corpus/canonical/*.md`) are already committed and
frozen. Chunk + embed + index them. Note the `--` before flags (pnpm needs it to
pass them through):

```bash
# a single config (fast, good for first run):
pnpm ingest -- --doc github-tos --strategy sentence --size 256

# the full Phase 1 sweep — 15 chunk+embed passes:
pnpm ingest -- --doc github-tos --all-configs
```

Available docs: `github-tos`, `netflix-tou`. To validate chunking + embedding
**without a database or network round-trip to Postgres**, add `--dry-run`
(writes nothing, needs no DB):

```bash
pnpm ingest -- --dry-run --doc github-tos --strategy sentence --size 256
```

### 6. Run the app

```bash
pnpm dev
```

- Backend (Hono) → **http://localhost:3000**
- Frontend (Vite) → **http://localhost:5173** (`/api` is proxied to `:3000`)

Open **http://localhost:5173** and ask a question over the ingested corpus.

---

## Verifying the setup

```bash
pnpm typecheck                        # tsc --noEmit across every workspace
pnpm test                             # hermetic unit tests (no DB, no model, no network)
pnpm --filter backend test:live       # non-hermetic: loads the real ~1.2 GB ONNX embedder
```

The hermetic suite runs against fakes, so it passes without Postgres, Ollama, or
the embedder model — a quick way to confirm the checkout is sound before doing
the heavier setup above.

---

## Common commands

```bash
pnpm dev            # backend (:3000) + frontend (:5173) via turbo
pnpm test           # vitest run across workspaces
pnpm typecheck      # tsc --noEmit everywhere
pnpm build          # currently only the frontend produces output

pnpm ingest -- --doc <doc> --strategy <s> --size <n>   # chunk + embed + index one config
pnpm ingest -- --doc <doc> --all-configs               # the 15-config Phase 1 sweep
pnpm fetch-canonical github-tos                        # refresh a canonical (see PRD §5 freeze protocol)
```

Per-workspace scripts run with `pnpm --filter <name> <script>`. Workspaces:
`backend`, `frontend`, `@tos-rag/core`, `@tos-rag/shared`, `@tos-rag/ui`,
`@tos-rag/db`.

---

## Project layout

```
apps/
  backend/     Hono API + local ingestion scripts (Node-only; owns the live pipeline)
  frontend/    React 19 + Vite SPA (hash routing; all network I/O via src/lib/api.ts)
packages/
  core/        the experiment's logic: chunkers, metrics, prompt, schemas, frozen constants
  shared/      API contract types + presentation helpers (backend and frontend agree here)
  ui/          presentational React components (shadcn primitives + hand-rolled visualizations)
  db/          Prisma schema + migrations + seed, pgvector helpers, local Supabase stack
corpus/
  canonical/   frozen Markdown documents — every chunk boundary / gold span is a char offset here
  *.pdf        archival snapshots (never parsed by the pipeline)
docs/          PRD (authoritative), architecture, design
```

## Troubleshooting

- **Backend exits immediately at boot** — it requires `DATABASE_URL` and fails
  fast without it. Confirm `apps/backend/.env` exists and Postgres is up.
- **`vector(768)` type errors during migrate** — pgvector must be installed; the
  local Supabase stack handles this. On a hosted Supabase project see
  `packages/db/supabase/README.md`.
- **Ask returns 503 for a config** — that `(strategy, size)` hasn't been
  ingested yet. Run the matching `pnpm ingest -- ...`, or use `--all-configs`.
- **Opus answers are unavailable** — set `ANTHROPIC_API_KEY` in
  `apps/backend/.env`. Without it, only the Llama (Ollama) arm is served.
- **Ollama connection refused** — start it (`ollama serve` / the app) and pull
  the model (`ollama pull llama3.1:8b`); check `OLLAMA_URL`.
