# Design — Ground-Truth Questions: Authoring Format & Build Pipeline

**Date:** 2026-07-23
**Status:** Draft for review
**Governs:** how `corpus/questions/<doc_id>.jsonl` (PRD §6) is authored and generated.
**Related:** PRD §5 (freeze protocol), §6 (ground-truth spec), §10.1/§10.4 (retrieval & abstention metrics), §16 acceptance criteria 2.

## 1. Problem

The experiment needs a ground-truth Q&A set: one JSONL file per canonical document, each
question carrying **gold spans** — character offsets into the canonical `.md` that satisfy the
invariant `canonical.slice(char_start, char_end) === quoted_text`. These offsets are what every
retrieval metric (char precision/recall, hit@8) is scored against.

The existing question PDFs are not machine-readable, their evidence is prose with ellipses (not
offsets), and ~9 of them target the Netflix **Privacy Statement**, which is out of scope (PRD §2)
and has no canonical document. Hand-writing character offsets against the canonical is
error-prone (markdown link syntax, curly apostrophes, UTF-16 units).

## 2. Decisions

- **The author re-creates the question set from scratch.** The PDFs are reference only.
- **Netflix Privacy-Statement topics become `unanswerable` questions** over the two-document
  corpus: their answers do not exist in `github-tos.md` or `netflix-tou.md`, so the correct RAG
  behavior is abstention. This exercises abstention precision/recall (PRD §10.4) and CRAG
  "Missing" (§10.3). Such questions carry `gold_quotes: []`, `expected_answer: "I don't know"`.
- **The author never writes character offsets.** They quote evidence verbatim; a build script
  computes and verifies offsets.
- **IDs are sequential** (`github-q01`, `netflix-q01`, …); the author sets `phase1` per question.
- **Authoring is in YAML**, one file per document. YAML block scalars (`|`) let long legal quotes
  containing quotes/apostrophes/newlines be pasted without escaping — far easier than JSONL.

## 3. File layout

```
corpus/questions/
  authoring/
    github-tos.yaml      # hand-authored (source of truth for humans)
    netflix-tou.yaml     # hand-authored
  github-tos.jsonl       # GENERATED — do not edit by hand
  netflix-tou.jsonl      # GENERATED — do not edit by hand
```

## 4. Authoring format (YAML)

Each file is a top-level list of question entries.

```yaml
# Answerable, single clause
- id: netflix-q01
  qtype: factual                # factual | multi_clause | comparison | unanswerable
  question: What is the minimum age to create a Netflix account?
  expected_answer: You must be at least 18, or the age of majority in your province, territory or country.
  phase1: true
  gold_quotes:
    - |
      You must be at least 18 years of age, or the age of majority in your province, territory or country, to create a Netflix account

# Answerable, multi-clause / comparison — several disjoint quotes
- id: netflix-q13
  qtype: comparison
  question: How does access loss differ when an Extra Member cancels vs when the Account Owner removes the feature?
  expected_answer: If the Extra Member cancels, access ends immediately; if the Account Owner removes the feature, access lasts until the end of the billing period.
  phase1: true
  gold_quotes:
    - |
      cancellation by the Extra Member will result in the Extra Member's immediate loss of access
    - |
      the Extra Member will retain access to the Netflix service until the end of the Account Owner's billing period

# Unanswerable (e.g. ex-Privacy-Statement topics)
- id: netflix-q20
  qtype: unanswerable
  question: Does Netflix sell your personal information to third-party data brokers?
  expected_answer: I don't know
  phase1: false
  gold_quotes: []
```

### Authoring rules

1. `gold_quotes` are copied **verbatim** from `corpus/canonical/<doc_id>.md` (raw markdown, not the
   rendered website). Keep each to the shortest sentence(s) containing the answer.
2. `expected_answer` is the author's own concise wording (scored by SQuAD-F1/cosine); it need not
   be verbatim. For `unanswerable` it must be exactly `I don't know`.
3. `unanswerable` → `gold_quotes: []`.
4. `qtype` vocabulary (maps the old PDF labels): `single-clause → factual`, `multi-clause →
   multi_clause`, `comparison → comparison`, `unanswerable → unanswerable`.

## 5. Build & validation pipeline

New script (invoked via a root `package.json` script, e.g. `pnpm build-questions`). Pure/testable
core in `packages/core` (offset resolution), thin CLI wrapper for I/O — mirrors the
`plan-ingest` / `ingest` split.

For each document:

1. Load and parse the YAML authoring file.
2. Load the canonical via the existing `loadCanonical` (verifies sha256 — fails on drift).
3. For each `gold_quote`: locate it against a **normalized projection** of the canonical (a plain
   `indexOf` fails on the real corpus — proven). Both sides are normalized three ways while the
   returned offsets still index the original canonical:
   - **Whitespace collapse** — authors line-wrap quotes, adding newlines the single-line canonical
     lacks.
   - **Smart-punctuation folding** — canonical uses `’ “ ” — –`; authors type ASCII.
   - **Markdown-link unwrapping** — canonical has `[text](url)`; authors quote only `text`.
   Then:
   - Not found → **error**, printing the question id and a near-miss hint (longest matching prefix
     + where it diverges) so the author can fix the quote.
   - Found more than once → **error** (ambiguous); author must lengthen the quote to make it
     unique.
   - Found once → record `{ char_start, char_end }` and assert the resolved slice round-trips:
     `normalize(canonical.slice(start,end)) === normalize(quote)`. The raw slice may include
     Markdown markup — it is a character range, not required to be balanced markup.
4. Emit `corpus/questions/<doc_id>.jsonl` in the exact PRD §6 schema:
   `{ id, doc_id, qtype, question, expected_answer, gold_spans, phase1 }`.

### Validation assertions (build fails on any)

- Every `id` globally unique; IDs match `^<doc_id>-q\d+$`.
- `qtype ∈ {factual, multi_clause, comparison, unanswerable}`.
- `unanswerable` ⇒ `gold_quotes: []` **and** `expected_answer == "I don't know"`; conversely a
  non-empty `gold_quotes` ⇒ not `unanswerable`.
- Answerable ⇒ at least one `gold_quote`, each resolving to a non-empty span.
- `phase1` present and boolean.
- Offsets are UTF-16 code units (`String.prototype.slice` semantics — matches the chunker
  invariant), never Postgres codepoint counts.

## 6. Testing

- Hermetic unit tests for the offset-resolver using a small fake canonical string: exact match,
  not-found (near-match reported), duplicate quote, multi-quote question, unanswerable passthrough,
  UTF-16 vs codepoint edge case (e.g. an emoji/astral char), curly-apostrophe literal match.
- A golden test that runs the resolver over both real canonicals once fixtures exist.

## 7. Out of scope (follow-ups, not this spec)

- Seeding the `questions` DB table from the generated JSONL (extend `packages/db` seed later).
- The Phase-1 / held-out balancing review across qtypes (author sets `phase1` for now).
- Inter-annotator agreement / Cohen's κ (PRD §6.3) — a manual protocol, not tooling here.
- Authoring the question content itself (the author's task; this spec defines the container).

## 8. Acceptance

- `pnpm build-questions` regenerates both JSONL files deterministically from the YAML.
- Every generated `gold_spans` entry satisfies `canonical.slice(start,end) === quote`.
- Malformed authoring input fails loudly with an actionable message (id + reason + near-match).
- Unit tests pass hermetically (no model, network, or DB).
