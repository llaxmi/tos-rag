# Plan: Write the PRD for tos-rag (Empirical Study of RAG Pipeline Design)

## Context

The repo is the FYP "An Empirical Study of Retrieval-Augmented Generation Pipeline Design" (Laxmi Lamichhane & Sudha Paudel, Gandaki College / Pokhara University). The proposal (`docs/FYP_ Proposal.md`) defines a two-phase controlled experiment over Terms of Service documents:

- **Phase 1**: 5 chunking strategies (fixed-size, recursive character, sentence-based, semantic, section-aware) × 3 chunk sizes × 2 documents × 10 questions, generator fixed to Llama-3.1-8B → picks the best chunking config.
- **Phase 2**: best config × 2 generators (Claude Opus 4.8 vs Llama-3.1-8B) × 30 questions (10 held-out).
- Metrics: character-span retrieval quality (LegalBench-RAG style), RAGAS-style faithfulness, CRAG-style reference-guided LLM-judge correctness (judge: Claude Sonnet 5), SQuAD F1/EM, cosine similarity, latency, token cost. Stats: bootstrap 95% CIs, exact Wilcoxon signed-rank, Holm–Bonferroni.
- Deliverables: findings + working demo (chat with evidence + results dashboard).

Current repo state: pnpm monorepo, `apps/backend` = Hono on Node with a Supabase client and a stub route; 5 PDFs in `corpus/`; no pipeline code yet. The user asked to build a PRD, research a clean implementation path, and decide the corpus format.

**The deliverable of this plan is `docs/PRD.md`** — not the implementation itself. Implementation planning comes after the PRD is approved.

## Decisions locked with the user (via AskUserQuestion)

1. **Experimental corpus**: GitHub Terms of Service + Netflix Terms of Use (2 docs, 2 orgs). Netflix Privacy Statement stays in repo but out of the experiment.
2. **Architecture**: Everything on Cloudflare Workers — Hono backend as a Worker using the `env.AI` binding for Workers AI, Supabase (Postgres + pgvector) for storage, Anthropic API via fetch. React frontend.
3. **Corpus format**: **Canonical Markdown** — one frozen `.md` per document; all chunk boundaries and gold clause spans are character offsets into this exact text (invariant: `chunk.text === canonical.slice(start, end)`).
4. **Corpus source**: Official web/Markdown sources — GitHub ToS from the CC0 `github/site-policy` repo Markdown; Netflix ToU from the official HTML page via turndown + hand-clean. PDFs in `corpus/` remain archival snapshots.
5. **Demo scope**: Chat over the fixed corpus with retrieved-chunk evidence + results dashboard. No document upload.
6. **Open-source generator**: `@cf/meta/llama-3.1-8b-instruct-fast` (128K ctx; the base variant was deprecated on Workers AI 2026-05-30).
7. **Embedder**: keep `@cf/google/embeddinggemma-300m` (768-dim), and because its Workers AI serving limit is **512 input tokens**, the chunk-size grid changes from 256/512/1024 to **128/256/512 tokens** (still 5×3 = 15 configs).
8. **Ground truth**: full Q&A pairs already exist in the two question PDFs; work = convert to JSONL + annotate gold character spans against the canonical Markdown.
9. **Inferential statistics**: TS pipeline stores per-question metric scores in Postgres; a small **Python script** (scipy permutation-based Wilcoxon, BCa bootstrap, statsmodels Holm) computes CIs/p-values into an `analysis_results` table the dashboard renders.
10. **Timeline**: ~1 month (target mid-August 2026).

## Decisions taken on the user's behalf (flagged for veto at review)

- **Token measuring stick**: the **Gemma tokenizer** (embeddinggemma's own, via `@huggingface/transformers` `AutoTokenizer`) — it is the binding constraint (512-token embed limit), so measuring chunk sizes in embedder tokens guarantees no silent truncation. Used only at ingestion time.
- **Chunk overlap fixed at 0** (cited literature: overlap adds cost without quality gains — Amiri & Bocklitz 2025, Bennani & Moslonka 2025/26).
- **Retrieval scope = whole corpus** (both docs per query), k=8, cosine distance, **exact scan** (no HNSW/IVFFlat — perfect recall, deterministic, trivial at this scale), stable tiebreak `ORDER BY embedding <=> q, id`.
- **Abstention protocol**: fixed generation prompt instructs the model to reply exactly "I don't know" when the answer is not in the retrieved context → CRAG rule maps it to *Missing*; faithfulness undefined (NULL) for abstentions.
- **Ingestion fallback**: chunking+embedding runs via an admin Worker endpoint; if free-plan CPU (10 ms) or subrequest (50) limits bite, the identical shared-package code runs as a local script (`pnpm ingest`) writing to the same Supabase tables. Recommend the $5 Workers Paid plan (30 s CPU, 1000 subrequests) — fits proposal budget.
- **Generation params fixed**: temperature 0, fixed seed, explicit `max_tokens` (Workers AI default is 256 — silent truncation trap), one fixed prompt template.

## Research findings to bake into the PRD (verified with sources by 3 research agents)

- **Workers AI**: `@cf/google/embeddinggemma-300m` — 768 dims fixed, 512-token max input, batch ≤100 texts/call. `@cf/meta/llama-3.1-8b-instruct-fast` — 128K ctx, supports `seed`+`temperature`, fp8-quantized (note in report). REST API callable externally; `env.AI` binding from Workers. Free tier 10k neurons/day ≈ ~530 RAG generations/day on `-fast`; embeddings negligible. Latency varies by GPU datacenter routing → report medians/p95, run phases in consistent sessions.
- **RAGAS faithfulness**: 2 LLM calls/answer (statement decomposition + batched NLI verdicts). Pitfalls: enforce `verdicts.length === statements.length` with retry; "no pronouns" decontextualization instruction; JSON drift → structured output + regex fallback; label metric "RAGAS-style".
- **CRAG judge**: rules first (lowercased "i don't know" → Missing; exact match → Accurate), else reference-guided **binary** LLM judge (temp 0, JSON, explanation-before-score, few-shot examples from `facebookresearch/CRAG` `prompts/templates.py`). Scores +1/0/−1; Truthfulness = accuracy − hallucination rate.
- **SQuAD F1/EM**: no maintained JS port — hand-roll ~30 lines replicating the official script exactly (ASCII punctuation set, article removal, empty-answer edge cases).
- **Wilcoxon in TS is a trap**: `@stdlib/stats-wilcoxon` silently falls back to normal approximation with ties/zeros (certain with 0/1 metrics) → hence Python: `scipy.stats.wilcoxon(zero_method='zsplit', method=PermutationMethod)` (exhaustive n=20, Monte Carlo n=30), `scipy.stats.bootstrap(method='BCa', n_resamples=10_000)`, `statsmodels multipletests(method='holm')`.
- **LegalBench-RAG char metrics**: precision = Σoverlap/Σretrieved-chars, recall = Σoverlap/Σgold-chars; **merge overlapping retrieved spans before counting**; hit-rate@8 is our own extension — define explicitly.
- **Chunking**: hand-roll all 5 strategies (~50–100 lines each) — LangChain JS splitters don't expose char offsets and trim chunks (breaks the offset invariant). Sentence segmentation via `Intl.Segmenter` (native char offsets; add abbreviation-merge post-pass). Semantic chunker = LlamaIndex-style: adjacent sentence-group embedding distances, breakpoint at 95th percentile, cap at chunk size. Section-aware = heading-based packing with recursive split of oversized sections.

## What to write: `docs/PRD.md` structure

1. **Overview & objectives** — restate the two research objectives; the PRD governs the software that produces them.
2. **Out of scope** — document upload, hybrid retrieval, prompt/embedding/k variation, SAC augmentation (future work), >2 documents.
3. **Deliverables** — (a) experiment results in Postgres + analysis tables, (b) demo chat + dashboard, (c) reproducible pipeline code.
4. **Architecture** — monorepo layout:
   - `apps/backend` — Hono Worker (wrangler): `/api/ask` (demo RAG), `/api/experiment/run-one` (one question×config×model per invocation; resumable via DB unique key), `/api/results/*` (dashboard data), `/admin/ingest`.
   - `apps/web` — React+Vite (Cloudflare static assets): chat + dashboard.
   - `packages/core` — chunkers, tokenizer, embedder/generator clients, retriever, prompts, deterministic metrics, zod schemas, DB types. Same code used by Worker and any local script.
   - `analysis/` — Python stats script + figure generation.
   - `corpus/` — archival PDFs; `corpus/canonical/*.md` (frozen, sha256 recorded); `corpus/questions/*.jsonl`.
   - Exact model IDs: `@cf/google/embeddinggemma-300m`, `@cf/meta/llama-3.1-8b-instruct-fast`, `claude-opus-4-8` (paid generator), `claude-sonnet-5` (judge).
5. **Corpus spec** — sources, conversion procedure (turndown + hand-clean), freeze protocol (sha256; any post-freeze edit invalidates spans → re-annotation), licensing/attribution notes.
6. **Ground-truth spec** — JSONL schema: `{id, doc_id, qtype: factual|multi_clause|comparison|unanswerable, question, expected_answer, gold_spans: [{char_start, char_end}], phase1: bool}`; annotation protocol (both annotators verify, Cohen's κ); helper script that locates candidate spans by fuzzy search to speed annotation.
7. **Experimental design** — 15 configs (5 strategies × 128/256/512 gemma-tokens), constants (k=8, prompt, temp 0, seed, overlap 0, embedder), Phase 1 (Llama-fast, 20 questions), Phase 2 (best config, both generators, 30 questions, held-out 10 reported separately).
8. **Module specs** — the proposal's 7 modules with TS interfaces: Loader, Chunker (`(canonical, size) → {char_start, char_end, text, token_count}[]` + offset invariant assertion), Embedder (batch ≤100, verify normalization), Vector Store, Retriever (RPC `match_chunks`), Generator, Evaluator.
9. **Data model (Supabase)** — `documents`, `configs`, `chunks` (per config, `vector(768)`), `questions`, `runs` (unique `(phase, config_id, model, question_id)` for resume; latency + token counts), `evals` (all per-run metric scores + judge explanation), `analysis_results`. Exact-scan RPC with config filter.
10. **Metrics & judge** — formulas and prompts per the research findings above (char-P/R/hit@8, RAGAS-style faithfulness, CRAG-style correctness, abstention P/R, SQuAD F1/EM, cosine, latency, cost); judge validation protocol (human sample + κ ≥ 0.61).
11. **Statistics plan** — the Python recipe above; every reported number traceable to `runs`/`evals` rows.
12. **Demo & dashboard requirements** — chat (doc picker, answer + evidence chunks with similarity scores, winning config), dashboard (15-config main table w/ CIs, 5×3 truthfulness heatmap, per-factor bar charts, Phase 2 paired table + win counts, latency box plots, cost table).
13. **Milestones (4 weeks, Jul 14 → Aug 14)** — W1: corpus freeze + Q&A JSONL + spans + schema + chunkers w/ unit tests; W2: ingestion + retrieval + generators + `/api/ask` + chat MVP + 3–5-question smoke test; W3: evaluator + orchestrator + run Phase 1 then Phase 2; W4: Python analysis + dashboard + judge validation + manual verification + report material.
14. **Risks & mitigations** — free-tier neuron pacing (or $5 paid plan), Workers CPU/subrequest limits at ingestion (local-script fallback, same code), Workers AI non-determinism even with seed (document; fixed seed best-effort), judge JSON drift (retry + regex), 512-gemma-token embed cap (ingestion-time assertion on every chunk), corpus freeze discipline.
15. **Deviations-from-proposal log** (for the defense): llama `-fast` variant (base deprecated), chunk grid 128/256/512 (embedder serving limit), corpus from official web sources instead of pdf-parse (cleaner canonical text; PDFs archival), Python for inferential stats (defensibility), overlap fixed at 0.
16. **Acceptance criteria** — chunker offset invariants pass on both docs; smoke test produces grounded answers; orchestrator resumes after interrupt; all 360 runs (300 Phase 1 + 60 Phase 2) present with evals; analysis tables populated; dashboard renders all figures; demo answers with evidence.

## Steps after plan approval

1. Write `docs/PRD.md` per the structure above (full detail, including DB DDL sketch, TS interfaces, prompt templates, JSONL examples).
2. Self-review the PRD (placeholders, contradictions, ambiguity, scope) and fix inline.
3. Ask the user to review the PRD; iterate on feedback.
4. (Next session/step) Invoke the writing-plans skill to turn the approved PRD into an implementation plan — implementation does not start under this plan.

## Verification

- PRD internally consistent with every locked decision above and with the proposal's experimental design (15 configs, n=20/30, metrics, phases).
- Every external fact in the PRD (model IDs, limits, formulas) matches the research agents' verified findings.
- User signs off on the deviations-from-proposal log (it is what they must defend academically).
