# Supabase schema

The experiment's data model (PRD §9). Apply these once, in numeric order, before
running `pnpm ingest`.

| File | What it does |
| --- | --- |
| `0001_extensions.sql` | Enables pgvector |
| `0002_schema.sql` | 7 tables + the `match_chunks` RPC + RLS |
| `0003_seed_configs.sql` | Seeds the 15 Phase 1 config rows |

## Applying

### Dashboard (no CLI needed)

Supabase Dashboard → SQL Editor. Paste and run each file **in order**, then verify:

```sql
select count(*) from configs;   -- expect 15
```

### CLI

```bash
supabase link --project-ref <ref>
supabase db push
```

The `NNNN_name.sql` naming is already CLI-compatible. The CLI additionally wants a
`supabase/config.toml` — `supabase init` generates one and will not clobber the
existing `migrations/` directory.

## If `vector(768)` fails to resolve

Supabase sometimes installs pgvector into the `extensions` schema rather than
`public`, and it is not on the default `search_path`. Either qualify the type:

```sql
embedding extensions.vector(768) not null
```

…or set the path for the session before running `0002`:

```sql
set search_path = public, extensions;
```

## Deviations from PRD §9

Both are recorded in the PRD's deviations log; noting them here so the SQL isn't
mistaken for a transcription error.

- **`create extension vector`** — PRD §9 assumes the extension already exists.
- **RLS enabled with no policies** — denies anon/authenticated outright. The
  backend uses the service-role key, which bypasses RLS, so nothing changes
  operationally; it silences the Supabase "table exposed without RLS" advisor.
- **`match_chunks` takes `p_doc_id`** — the doc filter used to run in TypeScript
  *after* the RPC returned k rows, which meant a doc-scoped question could come
  back with fewer than k chunks, or none.

## Do not add a vector index

`match_chunks` deliberately does an exact scan. HNSW/IVFFlat would make retrieval
approximate and non-deterministic, which invalidates every collected run. At this
scale (a few thousand rows per config) exact scan is fast and gives perfect recall.
