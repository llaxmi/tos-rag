# Real RAG ask + remove Cloudflare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/ask` retrieve from the real ingested chunks in the Supabase (Docker) vector DB over both corpus documents, and remove Cloudflare entirely — Llama generation moves to a local Ollama runtime.

**Architecture:** The Hono app stays environment-agnostic behind injected `AppDeps`. Cloudflare Workers AI (the old Llama generator and optional query embedder) is deleted; Llama is served by local Ollama over HTTP, Opus stays on the Anthropic API, embeddings stay on the local ONNX model. The demo fallback deps are removed, so the backend serves only the real pipeline and fails fast without `DATABASE_URL`. Netflix is added to the corpus via a one-time PDF→markdown canonical build, then both documents are ingested.

**Tech Stack:** TypeScript, Hono, Prisma + pgvector (Supabase Postgres in Docker), `@huggingface/transformers` (local ONNX embeddinggemma-300m), Ollama (`llama3.1:8b`), Anthropic Messages API (Opus), Vitest, pnpm workspaces + turbo.

## Global Constraints

- **Frozen experiment constants (never change):** `RETRIEVAL_K` = 8, temperature 0, `GENERATION_SEED` = 42, `GENERATION_MAX_TOKENS` = 1024, `CHUNK_SIZES` = 128/256/512, zero overlap, one fixed prompt template. (PRD §7.)
- **Same experimental model:** the open arm stays **Llama 3.1 8B** — only the *runtime* changes (Cloudflare Workers AI → Ollama). This is a logged PRD deviation, not a control change.
- **Offset invariant:** `chunk.text === canonical.slice(chunk.charStart, chunk.charEnd)`, in UTF-16 code units. Stored `chunks.text` and canonical text are never prefixed or trimmed.
- **Embedding prefixes are asymmetric and query/document-specific** (`EMBED_PREFIXES`, trailing spaces significant) and must never be persisted. `Embedder` exposes only `embedQuery` / `embedDocuments`.
- **Never mix embedders** across ingest and query. The local ONNX embedder is the only supported one after this change.
- **Packages are source-only:** extend `src/index.ts` barrels; no `dist`, no deep imports.
- **Verification gate is `pnpm typecheck` + `pnpm test`** (there is no linter). Non-hermetic checks live in `*.live.test.ts` and run only via `pnpm --filter backend test:live`.
- **Do not `git commit` unless explicitly authorized** by the user. The commit steps below are written for completeness; ask before running them if the user has a no-auto-commit rule in effect.

---

### Task 1: Remove the Cloudflare embedder

Delete the Workers-AI query embedder and every reference to it. Leaves `MODEL_IDS.embedder` / `EMBED_MAX_TOKENS_CF` defined-but-unused (cleaned up in Task 2), so the codebase still compiles after this task.

**Files:**
- Delete: `apps/backend/src/adapters/embedder.cf.ts`
- Modify: `apps/backend/src/adapters/index.ts`
- Modify: `apps/backend/test/embedder.test.ts` (remove the `createCfEmbedder` import + describe block)

**Interfaces:**
- Produces: `createEmbedder(env: { EMBEDDER?: string; EMBEDDER_DTYPE?: string }): Promise<Embedder>` — always the local embedder; rejects any `EMBEDDER` other than `local`.

- [ ] **Step 1: Delete the Cloudflare embedder file**

```bash
git rm apps/backend/src/adapters/embedder.cf.ts
```

- [ ] **Step 2: Simplify the embedder factory**

Replace the entire contents of `apps/backend/src/adapters/index.ts` with:

```ts
import { createLocalEmbedder, type LocalDtype } from "./embedder.local";
import type { Embedder } from "./embedder";

export type { Embedder } from "./embedder";
export { batched, withDocumentPrefix, withQueryPrefix } from "./embedder";
export { createLocalEmbedder, type LocalDtype } from "./embedder.local";
export {
  loadCanonical,
  normalizeCanonical,
  sha256,
  type CanonicalDoc,
} from "./canonical";

export interface EmbedderEnv {
  EMBEDDER?: string;
  EMBEDDER_DTYPE?: string;
}

/**
 * The experiment's embedder is the local ONNX embeddinggemma-300m, for both
 * ingestion and query time (PRD §8, §15). `EMBEDDER` is still read for
 * forward-compat but only `local` is supported now that the Cloudflare path is
 * gone; `EMBEDDER_DTYPE` selects fp32 | q8 | q4.
 */
export async function createEmbedder(env: EmbedderEnv): Promise<Embedder> {
  if (env.EMBEDDER && env.EMBEDDER !== "local") {
    throw new Error(
      `EMBEDDER=${env.EMBEDDER} is not supported — only the local ONNX embedder remains.`,
    );
  }
  return createLocalEmbedder({
    dtype: env.EMBEDDER_DTYPE as LocalDtype | undefined,
  });
}
```

- [ ] **Step 3: Remove the Cloudflare test import and describe block**

In `apps/backend/test/embedder.test.ts`:
- Delete the import line `import { createCfEmbedder } from "../src/adapters/embedder.cf";` (line 9).
- Delete the entire `describe("createCfEmbedder", () => { ... });` block (from line 82 through the end of the file). Keep the `prefixes`, `batched`, and `assertVectors` describe blocks and the `unit` helper (it is used by the `assertVectors` tests).

- [ ] **Step 4: Verify typecheck and hermetic tests pass**

Run: `pnpm --filter backend typecheck && pnpm --filter backend exec vitest run test/embedder.test.ts`
Expected: typecheck clean; embedder tests PASS (no `createCfEmbedder` suite).

- [ ] **Step 5: Verify no Cloudflare embedder references remain**

Run: `grep -rniE 'createCfEmbedder|embedder\.cf' apps/backend/src apps/backend/test || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/adapters/index.ts apps/backend/test/embedder.test.ts
git commit -m "refactor: remove Cloudflare Workers AI query embedder"
```

---

### Task 2: Core constants — Ollama Llama id, drop Cloudflare-only constants

Switch the Llama model id to the Ollama tag and delete the now-unused Cloudflare-only constants. `EMBED_BATCH_MAX` stays — `embedder.local.ts` uses it as its forward-pass batch guard.

**Files:**
- Modify: `packages/core/src/schemas.ts`
- Modify: `packages/core/src/index.ts` (barrel)

**Interfaces:**
- Produces: `MODEL_IDS.llama === "llama3.1:8b"`; `MODEL_IDS.embedder` and `EMBED_MAX_TOKENS_CF` no longer exist.

- [ ] **Step 1: Update MODEL_IDS in `packages/core/src/schemas.ts`**

Replace the `MODEL_IDS` block (lines 39–45) with:

```ts
export const MODEL_IDS = {
  embedderLocal: "onnx-community/embeddinggemma-300m-ONNX",
  llama: "llama3.1:8b", // Ollama tag (was @cf/meta/... on Workers AI; PRD §15)
  opus: "claude-opus-4-8",
  judge: "claude-sonnet-5",
} as const;
```

- [ ] **Step 2: Delete the Cloudflare token-cap constant**

In `packages/core/src/schemas.ts`, delete the `EMBED_MAX_TOKENS_CF` declaration and its doc comment (lines 69–74):

```ts
/**
 * Cloudflare's hosted endpoint caps input far below the model's real context.
 * A 512-token chunk plus the document prefix (~7 tokens) exceeds this, so the
 * largest configs would be silently truncated if ingestion ever moved to CF.
 */
export const EMBED_MAX_TOKENS_CF = 512;
```

Leave `EMBED_MAX_TOKENS` and `EMBED_BATCH_MAX` in place.

- [ ] **Step 3: Remove the barrel re-export**

In `packages/core/src/index.ts`, delete the `EMBED_MAX_TOKENS_CF,` line from the `export { ... } from "./schemas";` block. Keep `EMBED_BATCH_MAX`, `EMBED_MAX_TOKENS`, and the rest.

- [ ] **Step 4: Verify no references to the removed constants remain**

Run: `grep -rniE 'EMBED_MAX_TOKENS_CF|MODEL_IDS\.embedder\b' packages apps || echo "clean"`
Expected: `clean` (note `MODEL_IDS.embedderLocal` must still be present — the `\b` prevents it from matching).

- [ ] **Step 5: Verify core + backend typecheck and full test suite pass**

Run: `pnpm --filter @tos-rag/core typecheck && pnpm --filter @tos-rag/core test && pnpm --filter backend typecheck`
Expected: all clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/index.ts
git commit -m "refactor: point MODEL_IDS.llama at Ollama, drop Cloudflare-only constants"
```

---

### Task 3: Ollama generator + rewrite live deps generation

Add a hermetic, unit-tested Ollama generation module and wire it into `live.ts`, replacing the Workers-AI Llama call. Opus generation is unchanged.

**Files:**
- Create: `apps/backend/src/deps/ollama.ts`
- Create: `apps/backend/test/ollama.test.ts`
- Modify: `apps/backend/src/deps/live.ts`

**Interfaces:**
- Consumes: `GenerationResult` from `../app`; `GENERATION_SEED`, `GENERATION_MAX_TOKENS` from `@tos-rag/core`.
- Produces: `generateOllama(cfg: { url: string; model: string }, prompt: string, fetchImpl?: typeof fetch): Promise<GenerationResult>`. `LiveEnv` gains `OLLAMA_URL: string` and `OLLAMA_MODEL: string`, and loses `CF_ACCOUNT_ID` / `CF_API_TOKEN`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/test/ollama.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { generateOllama } from "../src/deps/ollama";

function okFetch(body: unknown, capture?: (url: string, init: RequestInit) => void) {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}

describe("generateOllama", () => {
  test("posts to /api/generate with frozen options and maps the response", async () => {
    let seenUrl = "";
    let seenBody: any;
    const fetchImpl = okFetch(
      { response: "  At least 30 days notice.  ", prompt_eval_count: 210, eval_count: 12 },
      (url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(init.body as string);
      },
    );

    const result = await generateOllama(
      { url: "http://localhost:11434", model: "llama3.1:8b" },
      "PROMPT",
      fetchImpl,
    );

    expect(seenUrl).toBe("http://localhost:11434/api/generate");
    expect(seenBody).toMatchObject({
      model: "llama3.1:8b",
      prompt: "PROMPT",
      stream: false,
      options: { temperature: 0, seed: 42, num_predict: 1024 },
    });
    expect(result.answer).toBe("At least 30 days notice."); // trimmed
    expect(result.inputTokens).toBe(210);
    expect(result.outputTokens).toBe(12);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("defaults token counts to 0 when Ollama omits them", async () => {
    const result = await generateOllama(
      { url: "http://x", model: "m" },
      "P",
      okFetch({ response: "ok" }),
    );
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test("throws a helpful error naming the url and model on non-OK", async () => {
    const badFetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    } as Response)) as unknown as typeof fetch;

    await expect(
      generateOllama({ url: "http://localhost:11434", model: "llama3.1:8b" }, "P", badFetch),
    ).rejects.toThrow(/Ollama.*llama3\.1:8b.*http:\/\/localhost:11434/s);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend exec vitest run test/ollama.test.ts`
Expected: FAIL — cannot resolve `../src/deps/ollama`.

- [ ] **Step 3: Implement the Ollama module**

Create `apps/backend/src/deps/ollama.ts`:

```ts
import { GENERATION_MAX_TOKENS, GENERATION_SEED } from "@tos-rag/core";
import type { GenerationResult } from "../app";

export interface OllamaConfig {
  /** Base URL of the Ollama server, e.g. http://localhost:11434 */
  url: string;
  /** Ollama model tag, e.g. llama3.1:8b */
  model: string;
}

interface OllamaGenerateResponse {
  response: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Llama generation via a local Ollama server (PRD §15 — replaces Workers AI).
 * The three sampling controls are frozen experiment constants: temperature 0,
 * seed 42, num_predict = GENERATION_MAX_TOKENS. `fetchImpl` is injectable so the
 * mapping stays unit-testable without a running server.
 */
export async function generateOllama(
  cfg: OllamaConfig,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerationResult> {
  const t0 = Date.now();
  const res = await fetchImpl(`${cfg.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        seed: GENERATION_SEED,
        num_predict: GENERATION_MAX_TOKENS,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Ollama generation failed: ${res.status} ${await res.text()}. ` +
        `Is Ollama running at ${cfg.url} with model ${cfg.model} pulled ` +
        `(\`ollama pull ${cfg.model}\`)?`,
    );
  }
  const json = (await res.json()) as OllamaGenerateResponse;
  return {
    answer: json.response.trim(),
    inputTokens: json.prompt_eval_count ?? 0,
    outputTokens: json.eval_count ?? 0,
    latencyMs: Date.now() - t0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter backend exec vitest run test/ollama.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire Ollama into `live.ts` and drop the Workers-AI code**

In `apps/backend/src/deps/live.ts`:

Update the imports — remove `MODEL_IDS` if it is no longer referenced after this edit (Opus still uses `MODEL_IDS.opus`, so keep it), and add the Ollama import:

```ts
import { generateOllama } from "./ollama";
```

Replace the `LiveEnv` interface with:

```ts
export interface LiveEnv {
  OLLAMA_URL: string;
  OLLAMA_MODEL: string;
  ANTHROPIC_API_KEY?: string;
}
```

Delete the `aiUrl` helper and the `runAi` function (the two Workers-AI helpers near the top of `createLiveDeps`).

Delete the entire `generateLlama` function.

In the returned deps object, change the `generate` field to:

```ts
    generate: (prompt, model) =>
      model === "opus"
        ? generateOpus(prompt)
        : generateOllama(
            { url: env.OLLAMA_URL, model: env.OLLAMA_MODEL },
            prompt,
          ),
```

Leave `generateOpus`, `resolveConfigId`, `retrieve`, `getAnalysisResults`, and `winningConfig` unchanged.

- [ ] **Step 6: Verify typecheck and no Workers-AI references remain in live deps**

Run: `pnpm --filter backend typecheck && grep -niE 'workers.?ai|cloudflare|CF_ACCOUNT|CF_API|runAi|aiUrl' apps/backend/src/deps/live.ts || echo "clean"`
Expected: typecheck clean; grep prints `clean`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/deps/ollama.ts apps/backend/test/ollama.test.ts apps/backend/src/deps/live.ts
git commit -m "feat: generate Llama answers via local Ollama instead of Workers AI"
```

---

### Task 4: Live-only boot, wire Ollama env, remove demo deps

Make the backend serve only the real pipeline: fail fast without `DATABASE_URL`, pass Ollama config through, and delete the demo fallback.

**Files:**
- Delete: `apps/backend/src/deps/demo.ts`
- Modify: `apps/backend/src/server.ts`

**Interfaces:**
- Consumes: `createLiveDeps(env: LiveEnv, embedder)` (Task 3), `createEmbedder(env)` (Task 1).

- [ ] **Step 1: Delete the demo deps**

```bash
git rm apps/backend/src/deps/demo.ts
```

- [ ] **Step 2: Rewrite `apps/backend/src/server.ts`**

Replace the entire file with:

```ts
import { serve } from "@hono/node-server";
import "dotenv/config";
import { createEmbedder } from "./adapters";
import { createApp } from "./app";
import { createLiveDeps } from "./deps/live";

const {
  DATABASE_URL,
  ANTHROPIC_API_KEY,
  EMBEDDER,
  EMBEDDER_DTYPE,
  OLLAMA_URL,
  OLLAMA_MODEL,
} = process.env;

// The backend serves only the real pipeline now (the demo fallback is gone).
// Without a database there is nothing to retrieve from, so fail loudly at boot
// rather than serving empty results.
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required — the backend serves the real pipeline only. " +
      "Start the local Supabase stack and copy apps/backend/.env.example to .env.",
  );
}

// Loads the ONNX model once, at boot, rather than per request.
const embedder = await createEmbedder({ EMBEDDER, EMBEDDER_DTYPE });

const deps = createLiveDeps(
  {
    OLLAMA_URL: OLLAMA_URL ?? "http://localhost:11434",
    OLLAMA_MODEL: OLLAMA_MODEL ?? "llama3.1:8b",
    ANTHROPIC_API_KEY,
  },
  embedder,
);

const app = createApp(deps);

const port = Number(process.env.PORT ?? 3000);
console.log(`tos-rag backend on :${port} (live, embedder ${embedder.name})`);

serve({ fetch: app.fetch, port });
```

- [ ] **Step 3: Verify typecheck and that no demo references remain**

Run: `pnpm --filter backend typecheck && grep -rniE 'createDemoDeps|deps/demo' apps/backend/src || echo "clean"`
Expected: typecheck clean; grep prints `clean`.

- [ ] **Step 4: Verify the full hermetic backend suite still passes**

Run: `pnpm --filter backend test`
Expected: PASS — `app.test.ts` (uses injected fakes), `ollama.test.ts`, `embedder.test.ts`, `plan-ingest.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/server.ts
git commit -m "feat: serve real pipeline only; require DATABASE_URL, drop demo deps"
```

---

### Task 5: Environment files and documentation

Update the env templates and the docs to reflect the Node-only, Ollama-based, no-Cloudflare stack.

**Files:**
- Modify: `apps/backend/.env.example`
- Modify: `apps/backend/.dev.vars` (currently empty)
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/PRD.md` (§15 deviations)

- [ ] **Step 1: Rewrite `apps/backend/.env.example`**

Replace its contents with:

```bash
# Copy to apps/backend/.env and fill in.
#
# The backend serves the REAL pipeline only and requires DATABASE_URL — it fails
# fast at boot without it (there is no demo fallback). Llama answers are served
# by a local Ollama server; Opus answers by the Anthropic API.

# Postgres (local Supabase stack: `pnpm --filter @tos-rag/db exec supabase start`).
# Production: the Supabase project's direct/pooled connection string.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# Ollama — the open/local generator arm (Llama 3.1 8B).
# Install: `brew install ollama`; then `ollama pull llama3.1:8b`.
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b

# Optional: enables the Opus generator arm for Phase 2.
ANTHROPIC_API_KEY=

# Embeddings run embeddinggemma-300m via ONNX in-process; `local` is the only
# supported value. fp32 | q8 | q4 (NOT fp16 — the activations do not support it).
EMBEDDER=local
EMBEDDER_DTYPE=fp32
```

- [ ] **Step 2: Replace `apps/backend/.dev.vars` with a pointer note**

`.dev.vars` was the Cloudflare/Wrangler local-secrets file. Replace its contents with a single comment so nobody re-adds Cloudflare secrets:

```bash
# Cloudflare/Wrangler is no longer used — the backend runs as a Node process.
# Runtime configuration lives in apps/backend/.env (see .env.example).
```

- [ ] **Step 3: Update `CLAUDE.md`**

Make these edits (search for the existing text):
- In the `deps/live.ts` bullet under "Dependency injection", replace "Llama generation via the Workers AI REST API" with "Llama generation via a local Ollama server (`/api/generate`)".
- Replace the `server.ts` sentence "picks live deps only when `DATABASE_URL`, `CF_ACCOUNT_ID`, and `CF_API_TOKEN` are all set; otherwise demo" with: "requires `DATABASE_URL` and serves the real pipeline only — it fails fast at boot without it. The demo fallback has been removed."
- In the `pnpm test:live` / commands area and anywhere `EMBEDDER=cf` or the Cloudflare Worker path is described, remove the Cloudflare mentions: the backend is Node-only and there is no `cf` embedder.
- In "Known divergences from the PRD", add: "Cloudflare is fully removed — no Worker deployment path, no `EMBEDDER=cf`. Llama is served by local Ollama (`OLLAMA_URL`/`OLLAMA_MODEL`). The offline demo deps were removed; the backend now requires `DATABASE_URL`."

- [ ] **Step 4: Update `docs/architecture.md`**

Remove/replace Cloudflare references: Workers AI as the Llama generator becomes Ollama; the `EMBEDDER=cf` query path and any "runs as a Cloudflare Worker" statements are struck in favour of "Node-only backend". Keep the surrounding structure; change only the affected sentences.

- [ ] **Step 5: Log the deviation in `docs/PRD.md` §15**

Append a dated entry to the §15 deviations list:

```markdown
- **2026-07-22 — Cloudflare removed.** The backend runs as a Node process only;
  the Cloudflare Worker deployment path is abandoned. The open generator arm
  (Llama 3.1 8B) is served by a local Ollama runtime (`/api/generate`) instead
  of Workers AI — same model, different runtime. The `EMBEDDER=cf` query-time
  embedder is deleted (the local ONNX embedder was already the ingest embedder).
  The offline demo deps are removed; the backend now requires `DATABASE_URL`.
```

- [ ] **Step 6: Verify no stray Cloudflare references remain in code/config**

Run: `grep -rniE 'cloudflare|CF_ACCOUNT|CF_API|workers.?ai|wrangler|EMBEDDER=cf' apps packages --include='*.ts' --include='*.json' --include='*.example' | grep -v node_modules || echo "clean"`
Expected: `clean` (matches in `docs/` describing the *removal* are fine and expected).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/.env.example apps/backend/.dev.vars CLAUDE.md docs/architecture.md docs/PRD.md
git commit -m "docs: describe Node-only Ollama stack; drop Cloudflare from env and docs"
```

---

### Task 6: Build and freeze the Netflix canonical document

Produce `corpus/canonical/netflix-tou.md` from the committed PDF, then freeze its sha256 into the manifest. Adds a reusable freeze script for hand-authored canonicals (the existing `fetch-canonical.ts` only handles URL sources).

**Files:**
- Create: `apps/backend/src/scripts/freeze-canonical.ts`
- Create: `corpus/canonical/netflix-tou.md`
- Create: `corpus/canonical/CHANGELOG.md`
- Modify (generated): `corpus/canonical/manifest.json`, `corpus/canonical/checksums.txt`

**Interfaces:**
- Consumes: `canonicalPath`, `normalizeCanonical`, `readManifest`, `writeManifest`, `sha256` from `../adapters/canonical`.
- Produces: `pnpm --filter backend exec tsx src/scripts/freeze-canonical.ts <doc-id> "<title>"` — normalizes an existing `corpus/canonical/<doc-id>.md` in place and records it in the manifest.

- [ ] **Step 1: Add the freeze script**

Create `apps/backend/src/scripts/freeze-canonical.ts`:

```ts
/**
 * Freezes a HAND-AUTHORED canonical document (PRD §5).
 *
 *   pnpm --filter backend exec tsx src/scripts/freeze-canonical.ts netflix-tou "Netflix Terms of Use"
 *
 * Unlike fetch-canonical (which pulls a URL), this takes an existing
 * corpus/canonical/<id>.md produced by hand — e.g. a PDF transcription —
 * normalizes it in place so the file on disk equals its canonical form, and
 * records its sha256 in manifest.json (+ checksums.txt). Re-running after
 * gold-span annotation has begun invalidates every span, which is why
 * loadCanonical verifies sha256 on every read.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalPath,
  normalizeCanonical,
  readManifest,
  sha256,
  writeManifest,
} from "../adapters/canonical";

async function main(): Promise<void> {
  const docId = process.argv[2];
  const title = process.argv[3];
  if (!docId || !title) {
    console.error('Usage: tsx src/scripts/freeze-canonical.ts <doc-id> "<title>"');
    process.exit(1);
  }

  const path = canonicalPath(docId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`${path} does not exist. Author it first, then freeze.`);
  }

  const text = normalizeCanonical(raw);
  await writeFile(path, text, "utf8"); // file on disk == normalized form
  const digest = sha256(text);

  const manifest = await readManifest();
  const prior = manifest[docId];
  if (prior && prior.sha256 !== digest) {
    console.warn(
      `\n!!  '${docId}' already frozen with a DIFFERENT sha256.\n` +
        `    was ${prior.sha256}\n    now ${digest}\n` +
        `    Every gold span recorded against it is now anchored to the wrong text.\n` +
        `    Writing version ${prior.version + 1}.\n`,
    );
  }
  manifest[docId] = {
    title,
    sha256: digest,
    version: prior && prior.sha256 !== digest ? prior.version + 1 : (prior?.version ?? 1),
    charLength: text.length,
  };
  await writeManifest(manifest);

  console.log(`froze ${path}`);
  console.log(`  sha256      ${digest}`);
  console.log(`  charLength  ${text.length} (UTF-16 code units)`);
  console.log(`  version     ${manifest[docId]!.version}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script typechecks**

Run: `pnpm --filter backend typecheck`
Expected: clean.

- [ ] **Step 3: Extract raw text from the Netflix PDF**

The corpus has `corpus/Netflix Terms of Use.pdf`. Extract its text into a scratch file for transcription. `pdftotext` is not installed on this machine, so use one of:

- Read the PDF directly with the Read tool (`pages` parameter, e.g. `1-20`) and transcribe its body text, **or**
- Install poppler and extract: `brew install poppler && pdftotext -layout "corpus/Netflix Terms of Use.pdf" /private/tmp/claude-501/-Users-laxmilamichanne-Developer-college-tos-rag/5a0c3891-678d-4be6-aa7e-9c253414c2a1/scratchpad/netflix-raw.txt`

Expected: the full Terms-of-Use prose available to transcribe.

- [ ] **Step 4: Hand-author `corpus/canonical/netflix-tou.md`**

Write the cleaned canonical markdown to `corpus/canonical/netflix-tou.md`, matching the conventions in `corpus/canonical/github-tos.md`:
- Body prose only. **Exclude** page headers/footers, page numbers, running titles, PDF extraction artifacts (hyphenation splits, stray form feeds), and any table-of-contents/navigation furniture that is not part of the terms.
- Use `##`/`###` markdown headings for the numbered sections of the Netflix Terms of Use.
- Normalize whitespace: single blank line between blocks, no trailing spaces. (`normalizeCanonical` in the next step will also enforce `\n` line endings, strip a leading front-matter/pragma block if present, trim, and guarantee a single trailing newline — but keep the source clean regardless.)
- Do **not** wrap or reflow paragraphs in a way that invents line breaks inside sentences; the text becomes the offset anchor for every future gold span.

- [ ] **Step 5: Record cleaning decisions in `corpus/canonical/CHANGELOG.md`**

Create `corpus/canonical/CHANGELOG.md` (or append if it exists):

```markdown
# Canonical corpus changelog

## netflix-tou (2026-07-22, v1)

Source: `corpus/Netflix Terms of Use.pdf` (committed in d38684f).
Build: PDF → text extraction → hand-clean → `normalizeCanonical` → freeze.

Cleaning decisions:
- Removed page headers/footers and page numbers.
- Rejoined words hyphenated across PDF line breaks.
- Converted the numbered section structure to `##`/`###` markdown headings.
- Excluded navigational/contact furniture that is not part of the terms.
```

Fill in any additional decisions you actually made.

- [ ] **Step 6: Freeze the document**

Run: `pnpm --filter backend exec tsx src/scripts/freeze-canonical.ts netflix-tou "Netflix Terms of Use"`
Expected: prints `froze .../netflix-tou.md`, a sha256, a `charLength`, and `version 1`. `manifest.json` now has a `netflix-tou` entry and `checksums.txt` has a second line.

- [ ] **Step 7: Verify the freeze holds and checksums match**

Run: `cd corpus/canonical && shasum -a 256 -c checksums.txt`
Expected: `github-tos.md: OK` and `netflix-tou.md: OK`.

- [ ] **Step 8: Verify `loadCanonical` accepts the frozen doc**

Run: `pnpm --filter backend exec tsx -e "import('./src/adapters/canonical').then(m => m.loadCanonical('netflix-tou')).then(d => console.log('OK', d.docId, d.text.length, d.sha256.slice(0,12)))"`
Expected: `OK netflix-tou <length> <sha-prefix>` (no drift error).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/scripts/freeze-canonical.ts corpus/canonical/netflix-tou.md corpus/canonical/CHANGELOG.md corpus/canonical/manifest.json corpus/canonical/checksums.txt
git commit -m "feat: build and freeze Netflix canonical document from PDF"
```

---

### Task 7: Seed the DB and ingest both documents into the vector store

Apply the schema, seed the 15 configs, ingest both documents, and verify `/api/ask` returns real chunks.

**Files:** none created — this is an operational task run against the running Supabase Docker Postgres (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`).

**Interfaces:**
- Consumes: `pnpm ingest` (chunk → local-embed → `insertChunks`), `resolveConfigId` (by `(strategy, chunk_size)`), the frozen canonicals from Task 6.

- [ ] **Step 1: Confirm the Supabase stack is up**

Run: `docker ps --format '{{.Names}}' | grep supabase && pnpm --filter @tos-rag/db exec supabase status | grep DB_URL`
Expected: supabase containers listed; `DB_URL` on `127.0.0.1:54322`.

- [ ] **Step 2: Apply migrations and generate the Prisma client**

Run: `pnpm --filter @tos-rag/db exec prisma migrate deploy && pnpm --filter @tos-rag/db exec prisma generate`
Expected: migrations applied (or "already applied"); client generated. (Prisma reads `DATABASE_URL` from `packages/db/.env`.)

- [ ] **Step 3: Seed the 15 configs**

Run: `pnpm --filter @tos-rag/db exec prisma db seed`
Expected: `seeded configs: N inserted, 15 total intended` (N is 0 on a re-run — seeding is idempotent).

- [ ] **Step 4: Dry-run ingest to validate chunking + embedding without writing**

Run: `pnpm --filter backend ingest -- --doc netflix-tou --strategy sentence --size 256 --dry-run`
Expected: `DRY RUN` banner, the canonical sha line, embedder-ready line, then a `sentence × 256 (config dry-run): N chunks, tokens min/median/max, Ns` line — no errors (offset invariant + full tiling pass).

- [ ] **Step 5: Smoke-test a single real ingest for each doc**

Run:
```bash
pnpm --filter backend ingest -- --doc github-tos  --strategy sentence --size 256
pnpm --filter backend ingest -- --doc netflix-tou --strategy sentence --size 256
```
Expected: each prints a `sentence × 256 (config <id>): N chunks …` line with a real config id (not `dry-run`).

- [ ] **Step 6: Verify chunks landed and text satisfies the offset invariant**

Run:
```bash
pnpm --filter backend exec tsx -e "
import('@tos-rag/db').then(async ({ matchChunks }) => {
  const { loadCanonical } = await import('./src/adapters/canonical');
  const { createLocalEmbedder } = await import('./src/adapters/embedder.local');
  const doc = await loadCanonical('netflix-tou');
  const emb = await createLocalEmbedder({});
  const v = await emb.embedQuery('How can I cancel my membership?');
  // config id for sentence×256 is resolved inside the API normally; look it up:
  const { prisma } = await import('@tos-rag/db');
  const cfg = await prisma.configs.findUnique({ where: { strategy_chunk_size: { strategy: 'sentence', chunk_size: 256 } }, select: { id: true } });
  const rows = await matchChunks(cfg.id, v, 8, 'netflix-tou');
  console.log('matched', rows.length, 'chunks; top score', rows[0]?.score?.toFixed(3));
  const r = rows[0];
  console.log('offset invariant holds:', r ? r.text === doc.text.slice(r.char_start, r.char_end) : 'no rows');
  await prisma.\$disconnect();
});
"
```
Expected: `matched 8 chunks; top score 0.xxx` and `offset invariant holds: true`.

- [ ] **Step 7: Run the full 15-config sweep for both documents**

Run:
```bash
pnpm --filter backend ingest -- --doc github-tos  --all-configs
pnpm --filter backend ingest -- --doc netflix-tou --all-configs
```
Expected: 15 `<strategy> × <size> (config <id>): …` lines per document, no errors. (This is slow — it runs 15 chunk+embed passes per doc.)

- [ ] **Step 8: Start the backend and confirm it boots live**

Run (background): `pnpm --filter backend dev`
Expected startup log: `tos-rag backend on :3000 (live, embedder local:onnx-community/embeddinggemma-300m-ONNX:fp32)`.

- [ ] **Step 9: Ask a question and confirm real evidence comes back**

Run:
```bash
curl -s localhost:3000/api/ask -H 'content-type: application/json' \
  -d '{"question":"How can I cancel my Netflix membership?","docId":"netflix-tou","strategy":"sentence","chunkSize":256,"model":"llama"}' \
  | python3 -m json.tool
```
Expected: JSON with a non-empty `answer`, `evidence` array of up to 8 chunks each carrying `docId: "netflix-tou"`, `charStart`/`charEnd`/`score`, `config: {strategy:"sentence",chunkSize:256}`, `model:"llama"`, and `timings`/`tokens`. Repeat with `"docId":"github-tos"` and a GitHub question to confirm the second document.

- [ ] **Step 10: Verify a different strategy/size routes to a different config**

Run the same curl with `"strategy":"section","chunkSize":128`.
Expected: 200 with `config: {strategy:"section",chunkSize:128}` and evidence whose spans differ from the sentence×256 run (confirming per-config retrieval, Objective 1). If the config was not ingested you get a 503 naming the missing config — re-run Step 7 for it.

- [ ] **Step 11: Stop the backend**

Stop the `pnpm --filter backend dev` process.

- [ ] **Step 12: Commit any operational notes (optional)**

No source changed in this task. If you captured ingest counts or timings worth keeping, add them to `corpus/canonical/CHANGELOG.md` and commit; otherwise nothing to commit.

---

## Notes on scope

Not included (per the approved spec): gold-span annotation, the `runs`/`evals` experiment harness, and the Python `analysis/` step. This plan delivers a working real-RAG `/api/ask` over both documents with no Cloudflare and Ollama-served Llama.
