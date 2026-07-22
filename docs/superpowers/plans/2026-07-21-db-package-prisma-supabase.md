# `@tos-rag/db` Package (Prisma + Supabase local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a shared `packages/db` (`@tos-rag/db`) workspace where Prisma owns the schema + migrations and the Supabase CLI provides only the local Postgres/Studio stack, then switch the backend's runtime data access off `@supabase/supabase-js` onto the shared Prisma client.

**Architecture:** Prisma's `schema.prisma` becomes the source of truth. `supabase start` runs containers; `DATABASE_URL` points Prisma at the local Supabase Postgres (`127.0.0.1:54322`) and `prisma migrate dev` applies all schema. pgvector (`vector(768)`), the `match_chunks` exact-scan RPC, RLS, and CHECK constraints — which Prisma cannot model — are hand-written into the Prisma init migration SQL, preserved verbatim from the three retired `supabase/migrations/*.sql` files. Two vector-touching operations (`matchChunks`, `insertChunks`) use raw SQL through Prisma because `chunks.embedding` is an `Unsupported` column.

**Tech Stack:** pnpm workspaces, Turbo, TypeScript (ESM, `moduleResolution: bundler`), Prisma ORM 6, Supabase CLI, Postgres + pgvector, Hono, tsx, Vitest.

## Global Constraints

- **Frozen experiment constants are immutable** — k=8, temperature 0, seed 42, `max_tokens` 1024, chunk sizes 128/256/512, zero overlap, one fixed prompt. Do not touch them.
- **`match_chunks` SQL body is preserved byte-for-byte** — exact-scan, no HNSW/IVFFlat index, `order by embedding <=> p_query, id`, 4 params `(p_config_id, p_query, p_k, p_doc_id)` with `p_doc_id default null`. It is an experimental control.
- **Character-offset invariant** — stored `chunks.text` is exactly `canonical.slice(char_start, char_end)`, never prefixed. Offsets are UTF-16 code units (JS `String.length`).
- **RLS posture preserved** — all seven tables get `enable row level security` with no policies (service-role/direct connection bypasses it).
- **Packages are source-only** (`main`/`exports` → `src/index.ts`, no `dist`). The sole exception is Prisma's generated client, which lands in `node_modules/.prisma` via `postinstall: prisma generate`.
- **`typecheck` is the gate** — there is no linter; `pnpm typecheck` must pass across all workspaces.
- **Local `DATABASE_URL`** = `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- **Prisma model names mirror table names** (snake_case): `documents`, `configs`, `chunks`, `questions`, `runs`, `evals`, `analysis_results`. Client accessors are therefore `prisma.documents`, `prisma.configs`, `prisma.analysis_results`, etc.
- **No git commits without explicit user permission.** Each task below ends with a *Checkpoint* (run the verification, report) rather than an automatic commit. Only run the `git commit` shown if the user has granted permission.

---

## File Structure

**Created:**
- `packages/db/package.json` — `@tos-rag/db` manifest; `prisma.seed` config; `postinstall`.
- `packages/db/tsconfig.json` — matches the other packages' tsconfig.
- `packages/db/prisma/schema.prisma` — datasource, generator, all seven models.
- `packages/db/prisma/migrations/<ts>_init/migration.sql` — generated then hand-edited (extension, vector column, RPC, RLS, CHECKs).
- `packages/db/prisma/seed.ts` — seeds the 15 configs.
- `packages/db/src/client.ts` — `PrismaClient` singleton.
- `packages/db/src/vector.ts` — `toVectorLiteral`, `matchChunks`, `insertChunks`.
- `packages/db/src/index.ts` — barrel.
- `packages/db/test/vector.test.ts` — unit test for `toVectorLiteral`.
- `packages/db/vitest.config.ts` — vitest config (mirrors core).
- `packages/db/.env.example` — `DATABASE_URL` for the Prisma CLI.
- `packages/db/.gitignore` — `.env`, generated client, supabase `.branches`/`.temp`.

**Moved:**
- `supabase/` → `packages/db/supabase/` (whole directory, including `config.toml`; the three files under `migrations/` are deleted after their content is folded into the Prisma init migration + seed).

**Modified:**
- `apps/backend/src/deps/live.ts` — supabase-js → Prisma.
- `apps/backend/src/scripts/ingest.ts` — supabase-js → Prisma + `insertChunks`.
- `apps/backend/src/server.ts` — live gate keys on `DATABASE_URL`.
- `apps/backend/package.json` — drop `@supabase/supabase-js`, add `@tos-rag/db`.
- `apps/backend/.env.example` — Supabase pair → `DATABASE_URL`.
- `CLAUDE.md` — update the ingestion-path / divergences prose to describe Prisma + the moved `supabase/`.

**Deleted (after fold-in):**
- `supabase/migrations/0001_extensions.sql`, `0002_schema.sql`, `0003_seed_configs.sql` (now inside `packages/db/prisma/migrations/<ts>_init/migration.sql` + `seed.ts`).

---

## Task 1: Scaffold the `@tos-rag/db` package and move `supabase/` into it

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/.env.example`, `packages/db/.gitignore`
- Move: `supabase/` → `packages/db/supabase/`

**Interfaces:**
- Produces: the `@tos-rag/db` workspace (installable via `workspace:*`); Supabase CLI runnable with `packages/db` as cwd.

- [ ] **Step 1: Stop the currently-running root Supabase stack (started from repo root)**

Run (from repo root):
```bash
npx supabase stop
```
Expected: `Stopped supabase local development setup.` (or a message that nothing is running — either is fine).

- [ ] **Step 2: Move the `supabase/` directory into the package**

```bash
mkdir -p packages/db
mv supabase packages/db/supabase
```
Expected: `packages/db/supabase/config.toml` now exists; `supabase/` no longer at repo root. (Plain `mv`, not `git mv` — `supabase/` is currently untracked, so `git mv` would fail. The three `migrations/*.sql` files move too and are removed in Task 2 Step 8.)

- [ ] **Step 3: Create `packages/db/package.json`**

```json
{
  "name": "@tos-rag/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "prisma": {
    "seed": "tsx prisma/seed.ts"
  },
  "scripts": {
    "postinstall": "prisma generate",
    "generate": "prisma generate",
    "migrate": "prisma migrate dev",
    "migrate:reset": "prisma migrate reset",
    "seed": "prisma db seed",
    "db:start": "supabase start",
    "db:stop": "supabase stop",
    "studio": "prisma studio",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@prisma/client": "^6.13.0",
    "@tos-rag/core": "workspace:*"
  },
  "devDependencies": {
    "prisma": "^6.13.0",
    "supabase": "^2.0.0",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.0.8"
  }
}
```

Note: `@tos-rag/core` is a dependency because `seed.ts` and the helpers use its frozen constants (`CHUNK_SIZES`). If `supabase@^2.0.0` fails to resolve at install, use the current published major of the `supabase` npm package — it only provides the CLI binary.

- [ ] **Step 4: Create `packages/db/tsconfig.json`** (mirrors `packages/core/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src", "test", "prisma"]
}
```

- [ ] **Step 5: Create `packages/db/.env.example`**

```bash
# Prisma CLI (migrate / seed / generate) reads DATABASE_URL from packages/db/.env.
# Copy to packages/db/.env and adjust if needed.
#
# Local Supabase Postgres (from `supabase start`, port 54322):
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
#
# Production: use the Supabase project's direct/pooled connection string.
# The backend runtime reads its own DATABASE_URL from apps/backend/.env.
```

- [ ] **Step 6: Create `packages/db/.gitignore`**

```gitignore
# Prisma / env
.env
.env.local

# Prisma generated client (regenerated via postinstall: prisma generate)
node_modules/

# Supabase local state (moved from the old root supabase/.gitignore)
supabase/.branches
supabase/.temp
supabase/.env.keys
supabase/.env.local
supabase/.env.*.local
```

- [ ] **Step 7: Point the Prisma CLI env at the local DB**

```bash
cp packages/db/.env.example packages/db/.env
```
Expected: `packages/db/.env` exists containing the local `DATABASE_URL`.

- [ ] **Step 8: Install so the workspace is wired**

Run (from repo root):
```bash
pnpm install
```
Expected: install succeeds; `@tos-rag/db` appears in the workspace. The `postinstall: prisma generate` will warn/fail because no schema exists yet — that is expected at this step and fixed in Task 2. If install hard-fails on postinstall, that is acceptable now; proceed to Task 2 which creates the schema, then re-run `pnpm install`.

- [ ] **Checkpoint:** `packages/db/supabase/config.toml` exists, root `supabase/` is gone, `@tos-rag/db` is in the workspace. (Commit only with permission.)
```bash
git add -A
git commit -m "feat(db): scaffold @tos-rag/db package, move supabase/ into it"
```

---

## Task 2: Author the Prisma schema, init migration (pgvector + RPC + RLS + CHECKs), and config seed

**Files:**
- Create: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<ts>_init/migration.sql` (generated, then hand-edited)
- Create: `packages/db/prisma/seed.ts`
- Delete: `packages/db/supabase/migrations/0001_extensions.sql`, `0002_schema.sql`, `0003_seed_configs.sql`

**Interfaces:**
- Produces: a local DB whose schema is identical to the retired SQL migrations — seven tables, `match_chunks(int, vector, int, text)`, RLS on all tables, 15 rows in `configs`. Prisma client generated with models `documents`, `configs`, `chunks`, `questions`, `runs`, `evals`, `analysis_results`.

- [ ] **Step 1: Start the local Supabase stack (containers only)**

Run (from repo root):
```bash
pnpm --filter @tos-rag/db exec supabase start
```
Expected: prints local API/DB URLs; DB reachable at `127.0.0.1:54322`. (First run pulls images.)

- [ ] **Step 2: Write `packages/db/prisma/schema.prisma`**

Every model mirrors `0002_schema.sql` exactly. `embedding` is `Unsupported("vector(768)")` (Prisma emits `vector(768)` in the migration but the column cannot be read/written via the model API — that is intentional; see `vector.ts`).

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model documents {
  id          String @id
  title       String
  sha256      String
  version     Int    @default(1)
  char_length Int
  chunks      chunks[]
  questions   questions[]
  runs        runs[]
}

model configs {
  id         Int      @id @default(autoincrement())
  strategy   String
  chunk_size Int
  chunks     chunks[]
  runs       runs[]

  @@unique([strategy, chunk_size])
}

model chunks {
  id          BigInt @id @default(autoincrement())
  config_id   Int
  doc_id      String
  char_start  Int
  char_end    Int
  text        String
  token_count Int
  embedding   Unsupported("vector(768)")
  configs     configs   @relation(fields: [config_id], references: [id])
  documents   documents @relation(fields: [doc_id], references: [id])

  @@index([config_id])
}

model questions {
  id              String @id
  doc_id          String
  qtype           String
  question        String
  expected_answer String
  gold_spans      Json
  phase1          Boolean
  documents       documents @relation(fields: [doc_id], references: [id])
  runs            runs[]
}

model runs {
  id             BigInt   @id @default(autoincrement())
  phase          Int
  config_id      Int
  model          String
  question_id    String
  retrieved      Json
  answer         String
  retrieval_ms   Int?
  generation_ms  Int?
  input_tokens   Int?
  output_tokens  Int?
  created_at     DateTime @default(now()) @db.Timestamptz(6)
  configs        configs   @relation(fields: [config_id], references: [id])
  questions      questions @relation(fields: [question_id], references: [id])
  evals          evals?

  @@unique([phase, config_id, model, question_id])
}

model evals {
  run_id           BigInt  @id
  char_precision   Float?
  char_recall      Float?
  hit_at_8         Float?
  faithfulness     Float?
  crag_score       Int?
  judge_explanation String?
  squad_f1         Float?
  squad_em         Float?
  cosine_sim       Float?
  cost_usd         Decimal? @db.Decimal(10, 6)
  runs             runs @relation(fields: [run_id], references: [id])
}

model analysis_results {
  id          BigInt   @id @default(autoincrement())
  analysis    String
  payload     Json
  computed_at DateTime @default(now()) @db.Timestamptz(6)
}
```

- [ ] **Step 3: Generate the init migration WITHOUT applying it**

Run (from repo root):
```bash
pnpm --filter @tos-rag/db exec prisma migrate dev --name init --create-only
```
Expected: creates `packages/db/prisma/migrations/<timestamp>_init/migration.sql` containing `CREATE TABLE` statements (including `embedding vector(768)`), the `configs` unique index, and FK constraints. It is NOT yet applied.

- [ ] **Step 4: Hand-edit the generated `migration.sql` — prepend the pgvector extension**

At the very TOP of `packages/db/prisma/migrations/<timestamp>_init/migration.sql`, add (content of the retired `0001_extensions.sql`):

```sql
-- pgvector. Must exist before the chunks.embedding vector(768) column below.
-- (Retired supabase/migrations/0001_extensions.sql, preserved here.)
create extension if not exists vector;
```

- [ ] **Step 5: Hand-edit the generated `migration.sql` — append CHECK constraints, the `match_chunks` RPC, and RLS**

At the BOTTOM of the same `migration.sql`, append the following (preserved verbatim from `0002_schema.sql` — CHECKs that Prisma omitted, the exact-scan RPC, and RLS):

```sql
-- CHECK constraints (Prisma migrate does not emit these).
alter table "configs"   add constraint configs_strategy_check   check (strategy in ('fixed','recursive','sentence','semantic','section'));
alter table "configs"   add constraint configs_chunk_size_check check (chunk_size in (128, 256, 512));
alter table "questions" add constraint questions_qtype_check    check (qtype in ('factual','multi_clause','comparison','unanswerable'));
alter table "runs"      add constraint runs_phase_check         check (phase in (1,2));
alter table "evals"     add constraint evals_crag_score_check   check (crag_score in (-1, 0, 1));

-- Exact-scan retrieval RPC. NO HNSW/IVFFlat INDEX — exact scan gives perfect
-- recall and deterministic ordering; an approximate index would make retrieval
-- non-deterministic and invalidate collected runs. Experimental control, not a
-- missing optimization. p_doc_id filters inside the scan so a doc-scoped
-- question still gets k rows. (Retired supabase/migrations/0002_schema.sql.)
create or replace function match_chunks(
  p_config_id int,
  p_query vector(768),
  p_k int,
  p_doc_id text default null
)
returns table (chunk_id bigint, doc_id text, char_start int, char_end int, text text, score real)
language sql stable as $$
  select id, doc_id, char_start, char_end, text,
         1 - (embedding <=> p_query) as score
  from chunks
  where config_id = p_config_id
    and (p_doc_id is null or doc_id = p_doc_id)
  order by embedding <=> p_query, id
  limit p_k;
$$;

-- RLS enabled with NO policies: anon/authenticated denied outright; the
-- service-role / direct connection bypasses RLS. Stops the advisor flagging
-- publicly-exposed tables. (Retired supabase/migrations/0002_schema.sql.)
alter table documents        enable row level security;
alter table configs          enable row level security;
alter table chunks           enable row level security;
alter table questions        enable row level security;
alter table runs             enable row level security;
alter table evals            enable row level security;
alter table analysis_results enable row level security;
```

Note: confirm the generated table names are unquoted lowercase (`configs`, not `"Configs"`) — the models are already lowercase so Prisma emits `configs`. If the generator quoted them differently, match that quoting in the appended SQL.

- [ ] **Step 6: Apply the edited migration**

Run:
```bash
pnpm --filter @tos-rag/db exec prisma migrate dev
```
Expected: `The following migration(s) have been applied` and `init` is marked applied; the Prisma client is regenerated. No errors about `vector` (the extension is created first).

- [ ] **Step 7: Write `packages/db/prisma/seed.ts`** (replaces `0003_seed_configs.sql` — the 15 Phase 1 cells)

```ts
/**
 * Seeds the 15 Phase 1 configs: 5 chunking strategies × 3 chunk sizes (PRD §7).
 * Idempotent — skipDuplicates makes re-running harmless. Ids are serial and
 * assigned in insert order; never hardcode them, always resolve by
 * (strategy, chunk_size). (Replaces retired supabase/migrations/0003_seed_configs.sql.)
 */
import { CHUNK_SIZES } from "@tos-rag/core";
import { PrismaClient } from "@prisma/client";

const STRATEGIES = ["fixed", "recursive", "sentence", "semantic", "section"] as const;

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const rows = STRATEGIES.flatMap((strategy) =>
    CHUNK_SIZES.map((chunk_size) => ({ strategy, chunk_size })),
  );
  const { count } = await prisma.configs.createMany({ data: rows, skipDuplicates: true });
  console.log(`seeded configs: ${count} inserted, ${rows.length} total intended`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 8: Delete the three now-retired SQL migration files**

```bash
rm packages/db/supabase/migrations/0001_extensions.sql \
   packages/db/supabase/migrations/0002_schema.sql \
   packages/db/supabase/migrations/0003_seed_configs.sql
```
Expected: files removed (plain `rm`, not `git rm` — these were untracked). Their content now lives in the Prisma init migration (`0001`+`0002`) and `seed.ts` (`0003`).

- [ ] **Step 9: Seed and verify the schema**

```bash
pnpm --filter @tos-rag/db exec prisma db seed
pnpm --filter @tos-rag/db exec supabase db execute --sql "select count(*) as configs from configs; select proname from pg_proc where proname = 'match_chunks';"
```
Expected: seed logs `15 inserted`; the query shows `configs = 15` and `match_chunks` present. (If `supabase db execute` is unavailable in your CLI version, use `psql "$DATABASE_URL" -c "select count(*) from configs;"` instead.)

- [ ] **Checkpoint:** local DB schema matches the retired migrations; 15 configs; `match_chunks` exists; Prisma client generated. (Commit only with permission.)
```bash
git add -A
git commit -m "feat(db): prisma schema, init migration (pgvector/RPC/RLS/CHECKs), config seed"
```

---

## Task 3: Prisma client singleton and the pgvector raw-SQL helpers

**Files:**
- Create: `packages/db/src/client.ts`, `packages/db/src/vector.ts`, `packages/db/src/index.ts`
- Create: `packages/db/vitest.config.ts`, `packages/db/test/vector.test.ts`

**Interfaces:**
- Produces:
  - `prisma: PrismaClient` — singleton (from `@tos-rag/db`).
  - `toVectorLiteral(v: number[]): string` — pgvector text literal, e.g. `[0.1,0.2]`.
  - `matchChunks(configId: number, queryVector: number[], k: number, docId: string | null): Promise<MatchedChunk[]>` where `MatchedChunk = { doc_id: string; char_start: number; char_end: number; text: string; score: number }`.
  - `insertChunks(configId: number, docId: string, rows: ChunkRow[]): Promise<void>` where `ChunkRow` is imported from the backend's `plan-ingest` shape: `{ char_start: number; char_end: number; text: string; token_count: number; embedding: number[] }`.
- Consumes: the generated `@prisma/client` and `@tos-rag/core` (none needed here beyond types).

- [ ] **Step 1: Create `packages/db/vitest.config.ts`** (mirrors core's; unit tests are hermetic)

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing test `packages/db/test/vector.test.ts`**

`toVectorLiteral` is the one pure, hermetic unit worth TDD (the DB-touching helpers are exercised by the Task 7 integration run).

```ts
import { describe, expect, it } from "vitest";
import { toVectorLiteral } from "../src/vector";

describe("toVectorLiteral", () => {
  it("formats a vector as a bracketed comma list with no spaces", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });

  it("handles an empty vector", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });

  it("does not use exponential notation for small magnitudes", () => {
    // pgvector's text input rejects nothing here, but 1e-7 must serialize as a
    // plain decimal the parser accepts.
    expect(toVectorLiteral([0.0000001])).toBe("[0.0000001]");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @tos-rag/db exec vitest run test/vector.test.ts
```
Expected: FAIL — `toVectorLiteral` is not exported / module `../src/vector` not found.

- [ ] **Step 4: Write `packages/db/src/client.ts`**

```ts
import { PrismaClient } from "@prisma/client";

/**
 * Process-wide Prisma singleton. The backend loads DATABASE_URL via its own
 * `dotenv/config`; scripts (seed, ingest) rely on the same env. One client per
 * process avoids exhausting the local Postgres connection limit under tsx watch.
 */
declare global {
  // eslint-disable-next-line no-var
  var __tosRagPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__tosRagPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__tosRagPrisma = prisma;
}
```

- [ ] **Step 5: Write `packages/db/src/vector.ts`**

```ts
import { prisma } from "./client";

/** Row shape returned by the match_chunks exact-scan RPC (chunk_id omitted). */
export interface MatchedChunk {
  doc_id: string;
  char_start: number;
  char_end: number;
  text: string;
  score: number;
}

/** Chunk row to persist — mirrors the backend's plan-ingest ChunkRow. */
export interface ChunkRow {
  char_start: number;
  char_end: number;
  text: string;
  token_count: number;
  embedding: number[];
}

/** Postgres rejects very large multi-row inserts; batch the writes. */
const INSERT_BATCH = 200;

/**
 * pgvector text input format: a bracketed, comma-separated list with no spaces.
 * `toFixed`-free — Number#toString already emits plain decimals for the
 * magnitudes an embedding produces and never switches to exponent form until
 * ~1e-7, which pgvector still parses.
 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Exact-scan retrieval via the match_chunks RPC (PRD §8). Invoked through
 * Prisma raw SQL because `embedding` is an Unsupported column and pgvector ops
 * cannot go through the model API. Same k, same ordering, same 4 params as the
 * supabase.rpc call it replaces. The query vector is passed as a text literal
 * cast to ::vector — a bare array will not coerce.
 */
export async function matchChunks(
  configId: number,
  queryVector: number[],
  k: number,
  docId: string | null,
): Promise<MatchedChunk[]> {
  return prisma.$queryRaw<MatchedChunk[]>`
    select doc_id, char_start, char_end, text, score
    from match_chunks(
      ${configId}::int,
      ${toVectorLiteral(queryVector)}::vector,
      ${k}::int,
      ${docId}::text
    )
  `;
}

/**
 * Replace all chunks for a (config, doc) pair, then batch-insert the new rows.
 * Idempotent per pair — a re-run cannot double the corpus. Uses $executeRaw
 * because `embedding` is an Unsupported column (prisma.chunks.create cannot set
 * a required Unsupported field). Stored `text` is the raw canonical slice,
 * never prefixed (offset invariant).
 */
export async function insertChunks(
  configId: number,
  docId: string,
  rows: ChunkRow[],
): Promise<void> {
  await prisma.chunks.deleteMany({ where: { config_id: configId, doc_id: docId } });

  const { Prisma } = await import("@prisma/client");
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    // One multi-row INSERT per batch. Prisma.sql fragments compose via
    // Prisma.join; the embedding is cast from its text literal to ::vector.
    await prisma.$executeRaw(
      Prisma.sql`
        insert into chunks (config_id, doc_id, char_start, char_end, text, token_count, embedding)
        values ${Prisma.join(
          batch.map(
            (r) =>
              Prisma.sql`(${configId}, ${docId}, ${r.char_start}, ${r.char_end}, ${r.text}, ${r.token_count}, ${toVectorLiteral(
                r.embedding,
              )}::vector)`,
          ),
        )}
      `,
    );
  }
}
```

- [ ] **Step 6: Write `packages/db/src/index.ts` (barrel)**

```ts
export { prisma } from "./client";
export {
  toVectorLiteral,
  matchChunks,
  insertChunks,
  type MatchedChunk,
  type ChunkRow,
} from "./vector";
```

- [ ] **Step 7: Run the unit test to verify it passes**

Run:
```bash
pnpm --filter @tos-rag/db exec vitest run test/vector.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 8: Typecheck the package**

Run:
```bash
pnpm --filter @tos-rag/db typecheck
```
Expected: no errors. (If `@prisma/client` types are missing, run `pnpm --filter @tos-rag/db exec prisma generate` first.)

- [ ] **Checkpoint:** helpers exist, unit test green, package typechecks. (Commit only with permission.)
```bash
git add -A
git commit -m "feat(db): prisma client singleton + pgvector matchChunks/insertChunks helpers"
```

---

## Task 4: Switch the backend live deps off supabase-js onto Prisma

**Files:**
- Modify: `apps/backend/src/deps/live.ts`
- Modify: `apps/backend/package.json` (add `@tos-rag/db`)

**Interfaces:**
- Consumes: `prisma`, `matchChunks` from `@tos-rag/db`; `RETRIEVAL_K`, `MODEL_IDS`, etc. from `@tos-rag/core` (unchanged).
- Produces: `createLiveDeps(env: LiveEnv, embedder: Embedder): AppDeps` with the same `AppDeps` shape; `LiveEnv` no longer carries `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Add `@tos-rag/db` to the backend (keep supabase-js for now)**

Edit `apps/backend/package.json` dependencies: add `"@tos-rag/db": "workspace:*"`. **Do NOT remove `@supabase/supabase-js` yet** — `ingest.ts` still imports it until Task 5, so removing it now would break the Task 4 typecheck on a missing module. It is removed in Task 6, once both `live.ts` (this task) and `ingest.ts` (Task 5) are off it. Then:
```bash
pnpm install
```
Expected: install succeeds; both `@tos-rag/db` and `@supabase/supabase-js` resolve for the backend.

- [ ] **Step 2: Rewrite the imports and `LiveEnv` in `apps/backend/src/deps/live.ts`**

Replace the top import block and `LiveEnv` interface:

```ts
import type { RetrievedChunk, Strategy } from "@tos-rag/core";
import {
  GENERATION_MAX_TOKENS,
  GENERATION_SEED,
  MODEL_IDS,
  RETRIEVAL_K,
} from "@tos-rag/core";
import { matchChunks, prisma } from "@tos-rag/db";
import type { Embedder } from "../adapters/embedder";
import type { AppDeps, GenerationResult } from "../app";

export interface LiveEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
}
```

(The `createClient(...)` line inside `createLiveDeps` and the `const supabase = ...` are deleted in the following steps.)

- [ ] **Step 3: Delete the supabase client construction**

In `createLiveDeps`, remove:
```ts
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
```
Leave the `aiUrl`/`runAi` helpers untouched (generation path is unchanged).

- [ ] **Step 4: Rewrite `resolveConfigId` to use Prisma**

Replace the body of `resolveConfigId`:

```ts
async function resolveConfigId(
  strategy: Strategy,
  chunkSize: number,
): Promise<number> {
  const key = `${strategy}:${chunkSize}`;
  const cached = configIds.get(key);
  if (cached !== undefined) return cached;
  const row = await prisma.configs.findUnique({
    where: { strategy_chunk_size: { strategy, chunk_size: chunkSize } },
    select: { id: true },
  });
  if (!row) {
    throw new Error(`Config ${strategy} × ${chunkSize} isn't ingested yet: not found`);
  }
  configIds.set(key, row.id);
  return row.id;
}
```

Note: `strategy_chunk_size` is the compound-unique input Prisma generates from `@@unique([strategy, chunk_size])`. If Prisma named it differently, use the name shown in the generated client type.

- [ ] **Step 5: Rewrite `retrieve` to use `matchChunks`**

Replace the `retrieve` function in the returned object:

```ts
retrieve: async (question, opts) => {
  // app.ts always fills strategy/chunkSize from winningConfig, so both are
  // present on every call and the config is resolved by identity.
  const configId = await resolveConfigId(
    opts?.strategy ?? "sentence",
    opts?.chunkSize ?? 256,
  );
  const vector = await embedder.embedQuery(question);
  const rows = await matchChunks(
    configId,
    vector,
    RETRIEVAL_K,
    // Filtered inside the scan, so a doc-scoped question still gets k rows.
    opts?.docId ?? null,
  );
  return rows.map(
    (r): RetrievedChunk => ({
      docId: r.doc_id,
      charStart: r.char_start,
      charEnd: r.char_end,
      text: r.text,
      score: r.score,
    }),
  );
},
```

- [ ] **Step 6: Rewrite `getAnalysisResults` to use Prisma**

```ts
getAnalysisResults: async () => {
  const rows = await prisma.analysis_results.findMany({
    select: { analysis: true, payload: true },
  });
  return rows;
},
```

Note: `AnalysisRow.payload` is typed `unknown` in `app.ts`; Prisma's `Json` is assignable to it.

- [ ] **Step 7: Typecheck the backend**

Run:
```bash
pnpm --filter backend typecheck
```
Expected: no errors. If TS complains that `env.SUPABASE_URL` is referenced anywhere else, remove those references (Task 6 handles `server.ts`).

- [ ] **Step 8: Run the existing backend tests (they use fake deps, must stay green)**

Run:
```bash
pnpm --filter backend test
```
Expected: PASS — `createApp` route tests inject fake deps and never touch live.ts.

- [ ] **Checkpoint:** live deps route through Prisma; backend typechecks; route tests green. (Commit only with permission.)
```bash
git add -A
git commit -m "feat(backend): live deps use @tos-rag/db prisma client instead of supabase-js"
```

---

## Task 5: Switch the ingest script off supabase-js onto Prisma + `insertChunks`

**Files:**
- Modify: `apps/backend/src/scripts/ingest.ts`

**Interfaces:**
- Consumes: `prisma`, `insertChunks` from `@tos-rag/db`; `planIngest`, `ChunkRow` from `./plan-ingest` (unchanged); `loadCanonical`, `createLocalEmbedder` (unchanged).
- Produces: the `ingest` CLI, same flags (`--doc`, `--strategy`, `--size`, `--all-configs`, `--dry-run`, `--dtype`), same idempotent replace-per-(config,doc) behavior.

- [ ] **Step 1: Replace the supabase imports and drop the SupabaseClient plumbing**

At the top of `ingest.ts`, replace:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
```
with:
```ts
import { insertChunks, prisma } from "@tos-rag/db";
```

- [ ] **Step 2: Rewrite `resolveConfigId` (Prisma)**

```ts
async function resolveConfigId(
  strategy: Strategy,
  chunkSize: number,
): Promise<number> {
  const row = await prisma.configs.findUnique({
    where: { strategy_chunk_size: { strategy, chunk_size: chunkSize } },
    select: { id: true },
  });
  if (!row) {
    throw new Error(
      `No configs row for ${strategy} × ${chunkSize}: not found. ` +
        `Run \`pnpm --filter @tos-rag/db exec prisma db seed\`.`,
    );
  }
  return row.id;
}
```

- [ ] **Step 3: Delete the old `writeChunks` function**

Remove the entire `writeChunks(supabase, configId, docId, rows)` function — `insertChunks` from `@tos-rag/db` replaces it (same delete-then-batch-insert, batch size 200).

- [ ] **Step 4: Rewrite the credential gate and the DB branch in `main`**

Replace the Supabase env check and client construction:

```ts
const args = parseArgs(process.argv.slice(2));

if (!args.dryRun && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. See apps/backend/.env.example.\n" +
      "To validate chunking and embedding without a database, pass --dry-run.",
  );
}
if (args.dryRun) console.log("DRY RUN — nothing will be written\n");
```

- [ ] **Step 5: Rewrite the `documents` upsert**

Replace the `supabase.from("documents").upsert(...)` block (guarded by `if (!args.dryRun)`):

```ts
if (!args.dryRun) {
  await prisma.documents.upsert({
    where: { id: canonical.docId },
    create: {
      id: canonical.docId,
      title: canonical.title,
      sha256: canonical.sha256,
      version: canonical.version,
      char_length: canonical.text.length,
    },
    update: {
      title: canonical.title,
      sha256: canonical.sha256,
      version: canonical.version,
      char_length: canonical.text.length,
    },
  });
}
```

- [ ] **Step 6: Rewrite the per-config write loop**

Replace the config-resolution and write inside the `for` loop:

```ts
for (const { strategy, chunkSize } of args.configs) {
  const started = Date.now();
  const configId = args.dryRun ? null : await resolveConfigId(strategy, chunkSize);

  const rows = await planIngest(canonical.text, canonical.docId, strategy, chunkSize, {
    countTokens: embedder.countTokens,
    embedDocuments: (texts) => embedder.embedDocuments(texts),
    embed: (texts) => embedder.embedDocuments(texts),
  });

  if (configId !== null) {
    await insertChunks(configId, canonical.docId, rows);
  }

  const tokens = rows.map((r) => r.token_count);
  console.log(
    `${strategy} × ${chunkSize} (config ${configId ?? "dry-run"}): ${rows.length} chunks, ` +
      `tokens min ${Math.min(...tokens)} / median ${median(tokens)} / max ${Math.max(...tokens)}, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
```

Remove the now-unused `const supabase = ...` line and any remaining `supabase` references.

- [ ] **Step 7: Typecheck**

Run:
```bash
pnpm --filter backend typecheck
```
Expected: no errors; no lingering references to `@supabase/supabase-js` or `SupabaseClient`.

- [ ] **Step 8: Dry-run smoke (no DB needed)**

Run:
```bash
pnpm ingest -- --doc github-tos --strategy sentence --size 256 --dry-run
```
Expected: prints `DRY RUN — nothing will be written`, the canonical sha, embedder ready, and a `sentence × 256 (config dry-run): N chunks ...` line. No DB connection attempted.

- [ ] **Checkpoint:** ingest uses Prisma; dry-run works with no DB; backend typechecks. (Commit only with permission.)
```bash
git add -A
git commit -m "feat(backend): ingest script writes via @tos-rag/db insertChunks/prisma"
```

---

## Task 6: Repoint the live/demo gate and env, drop supabase-js, refresh docs

**Files:**
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/.env.example`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `createLiveDeps(env: LiveEnv, embedder)` with the new `LiveEnv` (no Supabase fields).
- Produces: server chooses live deps when `DATABASE_URL`, `CF_ACCOUNT_ID`, `CF_API_TOKEN` are all set; demo otherwise.

- [ ] **Step 1: Rewrite the env destructuring and gate in `server.ts`**

Replace the `const { SUPABASE_URL, ... } = process.env;` block and the `live` check:

```ts
const {
  DATABASE_URL,
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  ANTHROPIC_API_KEY,
  EMBEDDER,
  EMBEDDER_DTYPE,
} = process.env;

const live = DATABASE_URL && CF_ACCOUNT_ID && CF_API_TOKEN;
```

- [ ] **Step 2: Rewrite the `createLiveDeps` call in `buildDeps`**

```ts
const deps = createLiveDeps(
  {
    CF_ACCOUNT_ID: CF_ACCOUNT_ID!,
    CF_API_TOKEN: CF_API_TOKEN!,
    ANTHROPIC_API_KEY,
  },
  embedder,
);
```

(The `createEmbedder({ EMBEDDER, EMBEDDER_DTYPE, CF_ACCOUNT_ID, CF_API_TOKEN })` call and the startup log line are unchanged. Prisma reads `DATABASE_URL` from `process.env` itself via `dotenv/config`, already imported at the top of `server.ts`.)

- [ ] **Step 3: Update `apps/backend/.env.example`**

Replace the Supabase block:

```bash
# Copy to apps/backend/.env and fill in.
#
# The backend runs the real pipeline only when DATABASE_URL, CF_ACCOUNT_ID and
# CF_API_TOKEN are ALL set. Otherwise it falls back to the offline demo deps,
# which are keyword matching over hardcoded excerpts and are never experimental
# results. The startup log line says which one is active.

# Postgres (local Supabase stack: `pnpm --filter @tos-rag/db exec supabase start`).
# Production: the Supabase project's direct/pooled connection string.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# Workers AI — generation (Llama 3.1 8B).
CF_ACCOUNT_ID=
CF_API_TOKEN=

# Optional: enables the Opus generator arm for Phase 2.
ANTHROPIC_API_KEY=

# Embeddings. `local` runs embeddinggemma-300m via ONNX in-process and is the
# default; `cf` calls Workers AI instead. Do not mix them — chunks indexed with
# one and queried with the other are not guaranteed to share a vector space.
EMBEDDER=local
# fp32 | q8 | q4. NOT fp16 — embeddinggemma's activations do not support it.
EMBEDDER_DTYPE=fp32
```

- [ ] **Step 4: Update `CLAUDE.md` prose**

Two edits to keep the docs accurate:
1. In the DI section, change the `live.ts` description from "pgvector exact-scan retrieval via the Supabase `match_chunks` RPC" to note it now goes "via the `@tos-rag/db` Prisma client (`matchChunks` raw-SQL helper over the same exact-scan `match_chunks` RPC)".
2. In "The ingestion path" / "Known divergences", replace the "Migrations live in `supabase/migrations/` and are applied by hand" paragraph with: migrations are now Prisma-owned in `packages/db/prisma/migrations`, applied by `prisma migrate dev`; the Supabase CLI provides the local stack only and lives at `packages/db/supabase`; `configs` are seeded by `prisma db seed` (`packages/db/prisma/seed.ts`). Add `@tos-rag/db` to the Workspaces list and note the backend is Prisma/Node-only.

- [ ] **Step 5: Typecheck everything**

Run (from repo root):
```bash
pnpm typecheck
```
Expected: all workspaces pass, including the new `@tos-rag/db`.

- [ ] **Step 6: Boot the backend with no DB to confirm the demo gate**

Run:
```bash
cd apps/backend && DATABASE_URL= CF_ACCOUNT_ID= CF_API_TOKEN= pnpm start
```
Expected: logs `tos-rag backend on :3000 (demo)`; `curl localhost:3000/api/health` → `{"ok":true}`. Ctrl-C to stop.

- [ ] **Checkpoint:** gate keys on `DATABASE_URL`; supabase-js fully removed; docs current; full typecheck green. (Commit only with permission.)
```bash
git add -A
git commit -m "feat(backend): live gate on DATABASE_URL, drop supabase-js, refresh env + docs"
```

---

## Task 7: End-to-end verification against the local stack

**Files:** none (verification only).

**Interfaces:** exercises the full path: `supabase start` → `prisma migrate` → `seed` → `ingest` → `/api/ask` through `matchChunks`.

- [ ] **Step 1: Ensure the stack is up and schema applied**

```bash
pnpm --filter @tos-rag/db exec supabase start
pnpm --filter @tos-rag/db exec prisma migrate reset --force
```
Expected: `migrate reset` drops+recreates, replays the init migration, and runs `prisma db seed` automatically (Prisma runs the configured seed after reset) — logs `15 inserted`. If your Prisma version does not auto-seed on reset, run `pnpm --filter @tos-rag/db exec prisma db seed`.

- [ ] **Step 2: Real ingest of one config (writes chunks + embeddings via `insertChunks`)**

Ensure `apps/backend/.env` has `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`, then:
```bash
pnpm ingest -- --doc github-tos --strategy sentence --size 256
```
Expected: `sentence × 256 (config <id>): N chunks, tokens min/median/max ...`. Verify rows landed:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select count(*) from chunks;"
```
Expected: N > 0.

- [ ] **Step 3: Confirm retrieval end-to-end**

Start the backend with full live env (needs `CF_ACCOUNT_ID`/`CF_API_TOKEN` for generation; retrieval alone proves the Prisma path):
```bash
cd apps/backend && pnpm start
```
In another shell:
```bash
curl -s localhost:3000/api/ask -H 'content-type: application/json' \
  -d '{"question":"Can I use GitHub if I am under 13?","strategy":"sentence","chunkSize":256,"model":"llama"}' | head -c 600
```
Expected: JSON with a non-empty `evidence` array whose items have `docId`/`charStart`/`charEnd`/`text`/`score` — proving `matchChunks` returned k rows through Prisma. (If CF creds are absent, generation 503s but retrieval still executes; a 503 with a `match_chunks` error means the Prisma path is broken, a 503 from the AI call is fine for this check.)

- [ ] **Step 4: Full typecheck + tests once more**

Run (from repo root):
```bash
pnpm typecheck && pnpm test
```
Expected: all green.

- [ ] **Checkpoint:** full local pipeline works on Prisma + the moved Supabase stack. Report results to the user. (Commit only with permission.)

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §Package layout → Task 1 (scaffold, move `supabase/`), Task 3 (`src/`).
- §Schema (models, `Unsupported`, extension, RPC, RLS, CHECKs) → Task 2.
- §`src/vector.ts` (`matchChunks`, `insertChunks`) → Task 3.
- §Supabase local stack (moved, devDep, migrations retired) → Task 1 + Task 2.
- §Backend changes (`live.ts`, `ingest.ts`, `server.ts`, `package.json`, `.env.example`) → Tasks 4, 5, 6.
- §Explicitly unchanged (frozen constants, exact-scan RPC, offset invariant, RLS) → enforced in Global Constraints + preserved verbatim in Task 2 Step 5.
- §Testing/acceptance → Task 7 (+ per-task typecheck/test checkpoints).
- §Why Node-only is acceptable → recorded in CLAUDE.md edit, Task 6 Step 4.

**Placeholder scan** — no TBD/TODO; every code step shows complete, runnable code.

**Type consistency** — `matchChunks(configId, vector, k, docId)` and `insertChunks(configId, docId, rows)` signatures match between the `@tos-rag/db` definition (Task 3), the `live.ts` consumer (Task 4), and the `ingest.ts` consumer (Task 5). `MatchedChunk`/`ChunkRow` field names (`doc_id`, `char_start`, `char_end`, `text`, `token_count`, `embedding`, `score`) are identical across producer and consumers and match `plan-ingest.ts`'s `ChunkRow`. Prisma accessors (`prisma.configs`, `prisma.documents`, `prisma.analysis_results`, `prisma.chunks`) match the snake_case model names in Task 2's schema. The compound-unique input `strategy_chunk_size` is used identically in Tasks 4 and 5 with the caveat note to match the generated name.
