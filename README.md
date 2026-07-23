# tos-rag

A controlled experiment on **RAG pipeline design over Terms-of-Service documents**, plus a public demo of the resulting pipeline. Phase 1 sweeps 5 chunking strategies × 3 chunk sizes (15 configs) with a fixed generator; Phase 2 compares Llama 3.1 8B vs Claude Opus 4.8 under the winning config.

- `docs/PRD.md` — the authoritative spec (experimental design, data model, metrics, acceptance criteria).
- `docs/architecture.md` — how the pieces fit together.
- `docs/design.md` — the frontend/visual design spec.
- `CLAUDE.md` — orientation for the codebase and its invariants.

**This README is a step-by-step setup guide written for someone new to the project.** No prior knowledge of RAG, pgvector, or monorepos is assumed. Follow it top to bottom.

---

## What you're setting up (in plain English)

The app answers questions about legal Terms-of-Service documents by (1) finding the most relevant passages in a document, then (2) asking a language model to answer using only those passages. To do that on your machine you need four things running:

| Piece | What it is | Why it's here |
| --- | --- | --- |
| **The app** | A backend API + a web page | What you actually open in the browser |
| **Postgres + pgvector** | A database that can search by meaning | Stores the document passages and finds relevant ones |
| **Ollama** | Runs an AI model locally on your computer | Generates the "Llama" answers, free and offline |
| **Embedder** | A small AI model (~1.2 GB) that downloads itself on first use | Turns text into the numbers the database searches over |

The **Opus** answers (Claude) are optional and need an Anthropic API key. Everything else runs locally and free.

> ⏱️ **Time & disk:** budget ~30 minutes end-to-end. First run downloads ~1.2 GB (the embedder) plus ~5 GB (the Llama model). Both are cached — you download them once.

---

## Prerequisites

Install these first. On each row, the last column is how to get it.

| Tool | Why you need it | How to install |
| --- | --- | --- |
| **Node.js ≥ 20** (22 LTS recommended) | Runs the backend, scripts, and the web build | [nodejs.org](https://nodejs.org) — download the LTS installer |
| **pnpm 11.12.0** | The package manager this repo uses | Comes with Node — see the one-time command below |
| **Docker Desktop** | Runs the local database in a container | [docker.com](https://www.docker.com/products/docker-desktop/) — install, then **launch the app so it's running** |
| **Ollama** | Runs the Llama model locally | macOS: `brew install ollama` · other: [ollama.com/download](https://ollama.com/download) |
| **Anthropic API key** | *Optional* — turns on the Opus answers | [console.anthropic.com](https://console.anthropic.com) |

**Turn on pnpm (run once):**

```bash
corepack enable
corepack prepare pnpm@11.12.0 --activate
```

**Check everything is present** before continuing:

```bash
node -v     # should print v20.x or higher
pnpm -v     # should print 11.12.0
docker ps   # should list containers (even if empty) — if it errors, Docker isn't running
ollama -v   # should print a version
```

If `docker ps` errors, open Docker Desktop and wait for it to say "running", then try again.

---

## Quickstart (copy-paste, in order)

If your prerequisites check out, this is the whole setup. Each block is explained in detail in the [Setup, step by step](#setup-step-by-step) section below — run these first, read the explanations if a step surprises you.

```bash
# 1. Install dependencies
pnpm install

# 2. Create the two env files from the committed examples (defaults work as-is)
cp apps/backend/.env.example apps/backend/.env
cp packages/db/.env.example   packages/db/.env

# 3. Start the database, create the tables, seed the 15 configs
pnpm --filter @tos-rag/db db:start     # needs Docker running
pnpm --filter @tos-rag/db migrate
pnpm --filter @tos-rag/db seed

# 4. Start Ollama and pull the Llama model (~5 GB, one time)
ollama serve                            # leave running in its own terminal; skip if Ollama.app is running
ollama pull llama3.1:8b

# 5. Load a document into the database (~1.2 GB embedder downloads on first run)
pnpm ingest -- --doc github-tos --strategy sentence --size 256

# 6. Run the app
pnpm dev
```

Then open **http://localhost:5173** and ask a question about the GitHub Terms of Service.

---

## Just want to see it work? (no database, no downloads)

To confirm your checkout is sound before doing the full setup, run the hermetic tests — they use fakes, so they need no database, no Ollama, and no model download:

```bash
pnpm install
pnpm test        # unit tests across all packages
pnpm typecheck   # type-checks every workspace
```

If those pass, the code is healthy and you can proceed to the full setup with confidence. You can also validate chunking + embedding with `--dry-run` (writes nothing, needs no database):

```bash
pnpm ingest -- --dry-run --doc github-tos --strategy sentence --size 256
```

---

## Setup, step by step

### 1. Install dependencies

```bash
pnpm install
```

This downloads all packages and automatically runs `prisma generate` (via the db package's `postinstall`), so the database client is ready. Expect it to take a minute or two the first time.

### 2. Configure environment

The project needs two `.env` files — one for the backend, one for the database CLI. The committed `.env.example` files already contain the correct local defaults, so **copying them works out of the box**:

```bash
cp apps/backend/.env.example apps/backend/.env
cp packages/db/.env.example   packages/db/.env
```

You only need to edit `apps/backend/.env` if you want the optional Opus (Claude) answers — paste your key into `ANTHROPIC_API_KEY`:

```dotenv
# apps/backend/.env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
ANTHROPIC_API_KEY=           # optional — leave blank to skip the Opus arm
EMBEDDER=local               # only supported value
EMBEDDER_DTYPE=fp32          # fp32 | q8 | q4  (NOT fp16)
```

> 🔒 `.env` files are git-ignored — your key never gets committed.

### 3. Start the database and set up its tables

The database runs inside Docker via the Supabase local stack (this gives you Postgres with the `pgvector` search extension). **Docker Desktop must be running first.**

```bash
pnpm --filter @tos-rag/db db:start   # starts Postgres in Docker on port 54322
pnpm --filter @tos-rag/db migrate    # creates the tables + the search function
pnpm --filter @tos-rag/db seed       # inserts the 15 chunking configs
```

The first `db:start` downloads Docker images and can take a few minutes. When it finishes it prints connection details — you don't need to copy them; the defaults in your `.env` already match.

**Check it worked** — this should open a browser tab showing a `configs` table with **15 rows**:

```bash
pnpm --filter @tos-rag/db studio     # Prisma Studio (a database viewer)
```

When you're done for the day, stop the database with:

```bash
pnpm --filter @tos-rag/db db:stop
```

### 4. Start Ollama and download the Llama model

Ollama runs the local AI model that produces the "Llama" answers.

```bash
ollama serve            # leave this running; skip if the Ollama.app is already running
ollama pull llama3.1:8b # downloads the model (~5 GB) — one time
```

Tip: run `ollama serve` in its own terminal window and leave it open. If you installed the Ollama desktop app, it may already be serving in the background, in which case you can skip `ollama serve`.

### 5. Load a document into the database ("ingest")

The documents live in `corpus/canonical/*.md` and are already committed. **Ingesting** chunks a document into passages, turns each into a searchable vector, and stores them. The first ingest downloads the ~1.2 GB embedder model.

```bash
# one config — fast, do this for your first run:
pnpm ingest -- --doc github-tos --strategy sentence --size 256

# OR the full Phase 1 sweep — all 15 configs (much slower):
pnpm ingest -- --doc github-tos --all-configs
```

> ℹ️ The `--` before the flags is required — pnpm needs it to pass the flags through to the script. Available documents: `github-tos`, `netflix-tou`.

### 6. Run the app

```bash
pnpm dev
```

This starts both halves at once:

- **Backend API** → http://localhost:3000
- **Web page** → **http://localhost:5173** ← open this one

Open **http://localhost:5173** and ask a question about the document you ingested. To stop the app, press `Ctrl+C` in that terminal.

---

## Verifying the setup

```bash
pnpm typecheck                        # type-checks every workspace
pnpm test                             # fast unit tests (no DB, no model, no network)
pnpm --filter backend test:live       # slower: loads the real ~1.2 GB embedder
```

The `pnpm test` suite runs against fakes, so it passes without Postgres, Ollama, or the embedder — the quickest way to confirm the checkout is sound.

---

## Common commands

```bash
pnpm dev            # backend (:3000) + frontend (:5173) together
pnpm test           # run all unit tests
pnpm typecheck      # type-check everything
pnpm build          # currently only the frontend produces output

pnpm ingest -- --doc <doc> --strategy <s> --size <n>   # load one config into the DB
pnpm ingest -- --doc <doc> --all-configs               # load all 15 configs
pnpm fetch-canonical github-tos                        # refresh a source document (see PRD §5)
```

Any package's own scripts run with `pnpm --filter <name> <script>`. Workspaces:
`backend`, `frontend`, `@tos-rag/core`, `@tos-rag/shared`, `@tos-rag/ui`,
`@tos-rag/db`.

---

## Project layout

```
apps/
  backend/     Hono API + local ingestion scripts (owns the live pipeline)
  frontend/    React 19 + Vite web app (all network I/O via src/lib/api.ts)
packages/
  core/        the experiment's logic: chunkers, metrics, prompt, schemas, constants
  shared/      API types shared by backend and frontend + presentation helpers
  ui/          presentational React components (shadcn primitives + visualizations)
  db/          database schema, migrations, seed, search helpers, local Supabase stack
corpus/
  canonical/   frozen Markdown documents — the source of truth for every passage
  *.pdf        archival snapshots (never parsed by the pipeline)
docs/          PRD (authoritative), architecture, design
```

---

## Troubleshooting

- **`docker ps` errors / `db:start` fails** — Docker Desktop isn't running. Open
  it, wait until it reports "running", then retry.
- **Backend exits immediately at startup** — it requires `DATABASE_URL` and fails
  fast without it. Confirm `apps/backend/.env` exists and the database is up
  (step 3).
- **`vector(768)` type errors during `migrate`** — pgvector isn't available. The
  local Supabase stack installs it automatically; make sure step 3's `db:start`
  succeeded. On a hosted Supabase project, see `packages/db/supabase/README.md`.
- **Asking a question returns a 503** — that `(strategy, size)` config hasn't been
  ingested yet. Run the matching `pnpm ingest -- ...`, or `--all-configs`.
- **"Ollama connection refused"** — Ollama isn't running or the model isn't
  pulled. Run `ollama serve` and `ollama pull llama3.1:8b`, and check `OLLAMA_URL`.
- **No Opus answers** — set `ANTHROPIC_API_KEY` in `apps/backend/.env`. Without a
  key, only the Llama (Ollama) answers are served — which is fine for local use.
- **First ingest/query seems to hang** — it's downloading the ~1.2 GB embedder
  from Hugging Face. It only happens once; subsequent runs are fast.
```
