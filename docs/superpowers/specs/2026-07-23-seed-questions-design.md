# Design — Seed questions into the database

**Date:** 2026-07-23
**Status:** Draft for review
**Governs:** loading `corpus/questions/*.jsonl` into the `questions` table (PRD §6, §9).

## 1. Purpose

The generated ground-truth JSONL exists on disk but nothing populates the `questions` table.
Runs (`runs`/`evals`) reference `questions.id`, so seeding is a prerequisite for the orchestrator.

## 2. Constraint

`questions.doc_id` is a foreign key to `documents`. `documents` rows are currently created only by
the `ingest` script (via `loadCanonical`, sha256-verified). Seeding questions must therefore ensure
the referenced `documents` exist first, or fail with a confusing FK error.

## 3. Approach (Option A)

A new backend script **`pnpm seed-questions`**, alongside `ingest` and `build-questions` (they live
in the backend because `loadCanonical` and `REPO_ROOT` do). Idempotent; runnable independent of
`ingest`.

Steps, per document (`github-tos`, `netflix-tou`):

1. **Ensure the `documents` row** — `loadCanonical(docId)` (sha256-verified, PRD §5) → upsert. To
   avoid duplicating the upsert `ingest.ts` already contains, extract `upsertDocument` into
   `@tos-rag/db` and use it in both.
2. **Upsert the questions** — read `corpus/questions/<docId>.jsonl`, validate each line with the
   existing `QuestionRecordSchema`, upsert by `id`. `gold_spans` → the `Json` column.

`--dry-run`: parse + validate + print a summary, write nothing, needs no database (mirrors
`ingest --dry-run`).

## 4. Components

- **`@tos-rag/core` `parseQuestionsJsonl(text): QuestionRecord[]`** (new, pure) — splits non-empty
  lines, `JSON.parse` + `QuestionRecordSchema.parse` each, throws with the 1-based line number on
  the first invalid line. Hermetically tested.
- **`@tos-rag/db`**:
  - `upsertDocument({ id, title, sha256, version, charLength })` — idempotent documents upsert.
  - `upsertQuestions(records: QuestionRecord[])` — idempotent per-id questions upsert; returns count.
- **`apps/backend/src/scripts/seed-questions.ts`** — thin I/O + orchestration: loadCanonical →
  upsertDocument → read JSONL → parseQuestionsJsonl → upsertQuestions; prints a per-doc summary
  (counts, phase1 split). Requires `DATABASE_URL` unless `--dry-run`.
- Wire `seed-questions` into `apps/backend/package.json` and the root `package.json`.
- Refactor `ingest.ts`'s inline documents upsert to call `upsertDocument` (DRY; small, related).

## 5. Testing

- Hermetic core tests for `parseQuestionsJsonl`: valid multi-line input → records; a malformed line
  → error naming the line number; blank/trailing lines ignored; schema violation (e.g. bad qtype)
  → error.
- Verify against the real JSONL via `pnpm seed-questions --dry-run` (no DB): 15 + 15 records parse,
  phase1 split reported.
- The Prisma upserts require a live DB (the user's local Supabase); not unit-tested here.

## 6. Out of scope

- The orchestrator (`run-one`) that consumes seeded questions.
- Seeding `documents`/`configs` into `prisma db seed` (Option B, rejected).
- Any change to the JSONL contents (owned by the authoring flow).

## 7. Acceptance

- `pnpm seed-questions --dry-run` validates both files and prints a summary with no DB.
- `pnpm seed-questions` (with `DATABASE_URL`) upserts documents + questions idempotently; a second
  run changes nothing.
- Core tests hermetic; typecheck clean.
