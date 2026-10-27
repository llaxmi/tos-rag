# tos-rag

A controlled experiment on **RAG pipeline design over Terms-of-Service documents**, plus a public demo of the resulting pipeline. Phase 1 sweeps 5 chunking strategies × 3 chunk sizes (15 configs) with a fixed generator; Phase 2 compares Llama 3.1 8B vs Claude Opus 4.8 under the winning config.

- `docs/PRD.md` — the authoritative spec (experimental design, data model, metrics, acceptance criteria).
- `docs/architecture.md` — how the pieces fit together.
- `docs/design.md` — the frontend/visual design spec.
- `CLAUDE.md` — orientation for the codebase and its invariants.

The findings and limitations come first, below. After them, **the rest of this README is a step-by-step setup guide written for someone new to the project.** No prior knowledge of RAG, pgvector, or monorepos is assumed. Follow it top to bottom.

---

## Findings

Corpus: 2 frozen documents (GitHub ToS, Netflix Terms of Use), 30 questions. Phase 1 uses 20 of them (16 answerable + 4 unanswerable); Phase 2 uses all 30, including 10 it had never seen. Answers are scored with CRAG Truthfulness (+1 accurate, 0 abstained, −1 hallucinated). Grading was done by an LLM judge (Claude Sonnet 5) that was checked against human labels.

| | Result |
| --- | --- |
| **Phase 1 — chunking** (15 configs × 20 questions, Llama 3.1 8B) | `sentence:512` and `recursive:256` tie at 0.900 mean Truthfulness. The tiebreak is char-recall (0.985 vs 0.898), which picks **`sentence:512`**. The lowest configs, `fixed:128` and `section:512`, score 0.500. Changing only the chunking moves quality from 0.500 to 0.900, an 80% relative gain. The two winners got the same score on all 20 questions; the tiebreak decided, and `recursive:256` generates in about half the time. |
| **Which factor mattered** | By strategy, **recursive** leads (0.833), then semantic and sentence (0.733), then fixed and section (0.600). By size, **256 tokens** leads (0.770), ahead of 512 (0.700) and 128 (0.630). All the confidence intervals overlap. |
| **Retrieval recall is a poor target** | Four configs retrieve almost all the gold text (char-recall ≈ 0.98, hit rate 1.00), yet their Truthfulness ranges from 0.600 to 0.900. `fixed:512` retrieves perfectly and still ranks 11th of 15. |
| **Phase 1 refusals** | Every config refused all 4 unanswerable questions (abstention recall 60/60). Precision is 0.952 after a manual audit: the 3 wrong refusals were all `section` configs on one question whose clause they never retrieved. |
| **Is the Phase 1 winner actually better?** | **No, it can't be shown.** 0 of 14 best-vs-rest paired Wilcoxon tests survive Holm correction, and every BCa confidence interval overlaps. Most questions score the same under every config: each comparison has 16–20 ties out of 20, so it rests on at most 4 questions that differ. The ranking describes these runs only; it doesn't prove one config is better. |
| **Phase 2 — generator** (`sentence:512`, 30 questions) | Claude Opus 4.8 **0.933** vs Llama 3.1 8B **0.600**. Opus wins on 5 questions, Llama on 0, and 25 tie. |
| **Where the gap comes from** | All of it is in synthesis questions: `comparison` (Opus 1.000 vs Llama 0.000) and `multi_clause` (0.750 vs 0.000). On `factual` and `unanswerable` questions both models score 1.000. Retrieval is identical on 30/30 questions, so the gap comes only from generation. Faithfulness is close (0.972 vs 0.947), so Opus doesn't win by hallucinating less; it wins by combining clauses. |
| **Cost** | Opus cost $0.672 for 30 runs ($0.022 per question), or **$0.134 per extra correct answer** over Llama. 84.3% of the bill is retrieved text going in, not the answer coming out, so retrieval depth (k) drives cost more than the choice of model. Llama is $0 in API cost because it ran locally. |
| **Is the Phase 2 gap significant?** | **No, 0 of 5 tested metrics after Holm correction.** For Truthfulness the models differ on only 5 questions, so the smallest p-value an exact paired test can reach is 2/2⁵ = 0.0625. That's above 0.05 however big the effect is, so this test fails even before correction (raw p = 0.062). Cosine similarity is the only metric that passes uncorrected (p = 0.021), and it doesn't survive Holm (0.104). |
| **Failure mode** | No Phase 2 answer scored CRAG 0. Every wrong answer was a hallucination, never a refusal. When the answer is in the retrieved text but has to be pieced together from several parts, neither model says "I don't know". |
| **Judge validity** | The LLM judge agrees with human annotators at κ = 0.920 (95% CI 0.795–1.000). The two humans agree with each other at κ = 0.920. Both are well above the 0.61 gate. |

**In one line:** chunking moves answer quality a lot in practice, and the generator matters for questions that need synthesis, not for simple lookups. With this many questions, though, the experiment can't statistically separate either chunking configs or generators. The thing holding it back is the number of questions, not the pipeline design.

## Limitations

- **Small question set.** With 20 questions in Phase 1 and 30 in Phase 2, mostly ties, there aren't enough differing questions for any comparison to reach significance. Treat every ranking as descriptive.
- **Two documents.** Both are English consumer ToS. The results may not hold for other legal genres or for longer contracts.
- **Gold spans were annotated once.** No second annotator marked the clause spans, so their inter-annotator κ can't be computed. Every config and generator is scored against the same spans, so any bias in them affects all arms equally. It doesn't touch Truthfulness.
- **The judge was validated on a balanced sample.** κ was measured on 50 rows, 25 judged accurate and 25 incorrect. The real population is about 83% accurate, so κ describes the sample, not that population. Rows decided by a rule (exact match, abstention) weren't part of the validation.
- **Abstention detection is a lower bound.** It only catches an answer that is exactly "I don't know". On `github-q15`, Opus explains the gap at length before saying "I don't know", so it counts as a miss (Opus abstention recall 0.750 vs Llama 1.000), even though the judge scored the answer +1.
- **Some arm comparisons aren't fair.** Token counts come from each model's own tokenizer, so they can't be compared. Latency mixes hosted Opus with Llama running on a laptop, so it reflects hardware, not the models.
- **Opus ran under one config only.** It was never tested on the other 14, so the generator result belongs to `sentence:512`.
- **One fixed setup.** k = 5, temperature 0, seed 42, a single prompt, a single local embedder (EmbeddingGemma), and zero chunk overlap. None of these were varied.
- **Scoring rule was amended mid-study.** A correct "I don't know" on an unanswerable question now scores +1 (PRD §15 #12). Stored answers were re-scored with no re-generation, and that change is what moved the Phase 1 winner from `recursive:256` to `sentence:512`.

Full reasoning is in `docs/PRD.md` §15 (logged deviations) and the project report.

---

## What you're setting up

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

pnpm run-phase2                                        # Phase 2: winner × {Llama, Opus} × 30 questions
pnpm analyze                                           # Python statistics → analysis_results (needs the DB)
pnpm analyze --dry-run                                 # compute + print, write nothing
pnpm backfill-metrics                                  # fill faithfulness/cosine/cost (dry run; --apply writes)
pnpm rescore-crag                                      # re-score stored answers (dry run; --apply writes)
pnpm judge-sample && pnpm judge-kappa                  # draw judge-validation sheets, then compute κ
```

The Python analysis lives in `analysis/` and is managed with [uv](https://docs.astral.sh/uv/).
Run `uv sync && uv run pytest` from that folder.

Any package's own scripts run with `pnpm --filter <name> <script>`. Workspaces:
`backend`, `frontend`, `@tos-rag/core`, `@tos-rag/shared`, `@tos-rag/ui`,
`@tos-rag/db`.

---

## Project layout

```
apps/
  backend/
    src/app.ts          Hono routes (/api/ask, /api/results, /api/health), built from injected deps
    src/deps/           live pipeline (pgvector retrieval, Ollama Llama, Anthropic Opus)
    src/adapters/       local embedder, canonical loader, LLM judge
    src/scripts/        one-shot CLIs: ingest, run-phase1/2, rescore-crag, backfill-metrics, …
  frontend/             React 19 + Vite app: #/ ask (chat + evidence rail), #/results dashboard
packages/
  core/                 the experiment's logic, no I/O
    src/chunkers/       the 5 chunking strategies (offset-preserving)
    src/metrics/        char-span precision/recall, SQuAD F1/EM, cosine
    src/eval/           CRAG scoring, faithfulness, cost
    src/orchestrator/   runOne: retrieve → generate → evaluate
    src/questions/      question-set loading
  shared/               API types shared by backend and frontend + presentation helpers
  ui/                   presentational React components (shadcn primitives + visualizations)
  db/                   Prisma schema, migrations, seed, search helpers, local Supabase stack
analysis/               Python (uv): Wilcoxon, BCa bootstrap, Holm, judge κ → analysis_results
  judge-validation/     blinded annotation sheets for the judge-vs-human check
corpus/
  canonical/            frozen Markdown documents, the source of truth for every passage
  questions/            question sets (*.jsonl) + authoring YAML with gold quotes
  *.pdf                 archival snapshots (never parsed by the pipeline)
docs/                   PRD (authoritative), architecture, design, superpowers plans/specs
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
