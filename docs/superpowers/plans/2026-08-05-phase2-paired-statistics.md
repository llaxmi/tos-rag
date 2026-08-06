# Phase-2 Paired Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute the Phase-2 paired statistics specified in `docs/superpowers/specs/2026-08-04-phase2-metrics-and-analysis-design.md` §5.5 and write them to `analysis_results` under the key `phase2_paired`, so report §6.7 can be written from database rows.

**Architecture:** Mirrors the existing `phase1.py` / `db.py` split exactly. `phase2.py` is pure — Phase-2 rows in, one payload dict out — and is tested with synthetic fixtures alone. `db.py` gains a single Phase-2 reader and remains the only module that touches Postgres. `cli.py` gains the new key and becomes genuinely selective, so `--only` no longer computes analyses it was not asked for. No new statistical primitives: `stats.py` (BCa bootstrap, Wilcoxon with seeded permutation, Holm) is reused unchanged.

**Tech Stack:** Python 3.12 (uv-managed, `analysis/`), numpy, scipy, statsmodels, psycopg, pytest. No new dependencies.

## Global Constraints

- **Do not commit or push.** The user commits. Every task ends with a *proposed* commit message, not a `git commit`. This overrides the sub-skill's commit steps.
- **Branch:** `feature/27` off `main`, created after the user confirms the issue. PR body says `Closes #27`.
- **No new dependencies.** `pyproject.toml` is not modified. Everything needed is already in `stats.py`.
- **NULL is never coerced to a number.** A missing `crag_score` raises rather than defaulting to 0 — 0 is a real CRAG score (Missing/abstention). A missing `faithfulness` is *expected* (abstentions) and is handled by pairwise deletion with an explicit count, never by substitution.
- **Frozen constants are untouchable:** k = 5, temperature 0, seed 42, `max_tokens` 1024, the prompt template, the judge model, `BOOTSTRAP_SEED = 42`, `BOOTSTRAP_RESAMPLES = 10_000`, `MONTE_CARLO_RESAMPLES = 99_999`.
- **No inferential statistics in TypeScript.** Everything here is Python.
- **Determinism is a claim the report makes.** Re-running `pnpm analyze` must be byte-identical. No `random` without the seeded generators already in `stats.py`, no wall-clock in a payload.
- **Run Python from `analysis/`:** `uv run pytest`, `uv run analyze --dry-run`. The `supabase_db_tos-rag` container must be up for anything touching the database (`docker start supabase_db_tos-rag`).
- **Writes only `analysis_results`.** Nothing in this plan touches `runs`, `evals`, `questions`, or `configs`. Prisma owns the schema; there is no migration here.

## Verified Ground Truth

These were read from the live database on 2026-08-05 before this plan was written. The implementation must reproduce them.

| Fact | Value |
|---|---|
| Phase-2 grid | 2 models × 30 questions × 1 config (`config_id = 9`, `sentence:512`) |
| Model ids | `claude-opus-4-8`, `llama3.1:8b` |
| Mean `crag_score` | Opus **0.9333**, Llama **0.6000** |
| Paired win counts on `crag_score` | Opus 5, Llama 0, ties 25 |
| Mean `faithfulness` | Opus 0.9721 (n = 27), Llama 0.9470 (n = 26) |
| `faithfulness` incomplete pairs | **4** questions → 26 usable pairs |
| Mean `cosine_sim` | Opus 0.8653, Llama 0.8101 |
| Mean `squad_f1` | Opus 0.5685, Llama **0.5964** — Llama ahead |
| Mean `squad_em` | Opus 0.1000, Llama **0.1333** — Llama ahead |
| Mean `char_recall` | 0.9906 on both arms; **0 of 30** questions differ |
| Total `cost_usd` | Opus $0.671910, Llama $0.000000 |
| Total tokens | Opus 113,267 in / 4,223 out; Llama 75,448 in / 1,422 out |
| Median `generation_ms` | Opus 2855.5, Llama 6792.5 |
| Held-out questions (`questions.phase1 = false`) | 10 — 6 factual, 2 comparison, 2 multi_clause |
| Unanswerable questions | 4, **all of them in the Phase-1-reused 20** |

Two consequences the code must handle rather than assume away:

1. **The held-out subset contains no unanswerable questions**, so abstention precision/recall is undefined there. The payload must say why rather than emit a zero.
2. **`squad_f1`/`squad_em` run opposite to the headline.** They are in the tested family precisely so the report cannot quietly show only the metrics that agree.

## File Structure

| File | Responsibility |
|---|---|
| `analysis/src/tosrag_analysis/phase2.py` | **New.** Pure: `Phase2Row`, `is_abstention`, `assert_phase2_shape`, pairing, and every payload builder. No I/O. |
| `analysis/tests/test_phase2.py` | **New.** Hermetic tests against a synthetic 2 × N frame. No database, no network. |
| `analysis/src/tosrag_analysis/db.py` | **Modify.** Add `PHASE2_QUERY` and `load_phase2_rows`. |
| `analysis/src/tosrag_analysis/cli.py` | **Modify.** Register the Phase-2 key, load only what `--only` selects, print a Phase-2 summary. |
| `CLAUDE.md` | **Modify.** Document `phase2.py` in the analysis-path section. |
| `docs/report-notes.md` | **Modify.** Append the session entry with the real numbers. |

`phase2.py` deliberately does not import from `phase1.py` except for `ShapeError`, so the two analyses cannot drift into sharing a fixture-shaped assumption. `ShapeError` is shared because `cli.py` catches exactly one exception type.

---

### Task 1: `phase2.py` foundations — row type, abstention predicate, shape assertion

**Files:**
- Create: `analysis/src/tosrag_analysis/phase2.py`
- Create: `analysis/tests/test_phase2.py`

**Interfaces:**
- Consumes: `ShapeError` from `.phase1`; `clean_values`, `estimate`, `holm`, `paired_wilcoxon`, `Estimate` from `.stats`.
- Produces:
  - `TREATMENT_MODEL: str = "claude-opus-4-8"`, `BASELINE_MODEL: str = "llama3.1:8b"`
  - `EXPECTED_MODELS: tuple[str, str]`, `EXPECTED_QUESTIONS: int = 30`
  - `HEADLINE_METRIC: str = "crag_score"`, `TESTED_METRICS: tuple[str, ...]`, `RETRIEVAL_METRICS: tuple[str, ...]`
  - `METRIC_NOTES: dict[str, str]`, `RETRIEVAL_METRIC_NOTES: dict[str, str]`
  - `UNANSWERABLE_QTYPE: str = "unanswerable"`
  - `Phase2Row` frozen dataclass with `.metric(name)`
  - `is_abstention(answer: str) -> bool`
  - `assert_phase2_shape(rows, expected_models=EXPECTED_MODELS, expected_questions=EXPECTED_QUESTIONS) -> None`

- [ ] **Step 1: Write the failing tests**

Create `analysis/tests/test_phase2.py`:

```python
"""Hermetic tests for the Phase-2 payload builders, against a synthetic 2 x N frame."""

from __future__ import annotations

import pytest

from tosrag_analysis.phase2 import (
    BASELINE_MODEL,
    TREATMENT_MODEL,
    Phase2Row,
    ShapeError,
    assert_phase2_shape,
    is_abstention,
)

# Exhaustive sign-flip permutation costs 2**n per comparison, so the real 30-question
# frame runs seeded Monte Carlo (n > 20) and the small frame runs exhaustive 2**10.
# Logic tests use the small frame; the full-size frame is exercised once, in TestBuildAll.
SMALL_QUESTIONS = [f"q{i:02d}" for i in range(10)]
QUESTIONS = [f"q{i:02d}" for i in range(30)]

# Mirrors the real split: the last 4 questions stand in for the unanswerable ones, and
# they sit inside the Phase-1-reused set, never the held-out set (verified 2026-08-05).
UNANSWERABLE_COUNT = 4
HELD_OUT_COUNT = 3


def make_rows(
    score_for=None,
    faithfulness_for=None,
    answer_for=None,
    recall_for=None,
    latency_for=None,
    cost_for=None,
    questions=None,
) -> list[Phase2Row]:
    """A complete Phase-2 frame. Callers override the metric a given test cares about."""
    score_for = score_for or (lambda model, qid: 1.0 if model == TREATMENT_MODEL else 0.0)
    faithfulness_for = faithfulness_for or (lambda model, qid: 0.9)
    recall_for = recall_for or (lambda model, qid: 0.99)
    latency_for = latency_for or (lambda model, qid: 1000.0 if model == TREATMENT_MODEL else 5000.0)
    cost_for = cost_for or (lambda model, qid: 0.02 if model == TREATMENT_MODEL else 0.0)
    questions = questions or QUESTIONS

    unanswerable_ids = set(questions[-UNANSWERABLE_COUNT:])
    # Held-out questions are drawn from the front, so they never overlap the
    # unanswerable ones at the back — the real corpus splits the same way.
    held_out_ids = set(questions[:HELD_OUT_COUNT])
    answer_for = answer_for or (
        lambda model, qid: "I don't know" if qid in unanswerable_ids else f"answer to {qid}"
    )

    rows = []
    for model in (TREATMENT_MODEL, BASELINE_MODEL):
        for qid in questions:
            unanswerable = qid in unanswerable_ids
            rows.append(
                Phase2Row(
                    model=model,
                    question_id=qid,
                    qtype="unanswerable" if unanswerable else "factual",
                    held_out=qid in held_out_ids,
                    answer=answer_for(model, qid),
                    crag_score=score_for(model, qid),
                    # Faithfulness is NULL for abstentions (PRD 10.2) — the pairs are
                    # genuinely fewer than the question count, by design.
                    faithfulness=None if unanswerable else faithfulness_for(model, qid),
                    cosine_sim=0.8,
                    squad_f1=0.5,
                    squad_em=0.0,
                    # Retrieval metrics are NULL for unanswerable questions (PRD 10.1).
                    char_precision=None if unanswerable else 0.05,
                    char_recall=None if unanswerable else recall_for(model, qid),
                    hit_at_8=None if unanswerable else 1.0,
                    retrieval_ms=12.0,
                    generation_ms=latency_for(model, qid),
                    input_tokens=100,
                    output_tokens=20,
                    cost_usd=cost_for(model, qid),
                )
            )
    return rows


class TestIsAbstention:
    """A cross-language copy of isAbstention in packages/core/src/prompts.ts.

    Three consumers must agree on what an abstention is (the evaluator, the
    faithfulness NULL rule, and 10.4), so the predicate is pinned here case by case.
    """

    @pytest.mark.parametrize(
        "answer",
        [
            "I don't know",
            "i don't know",
            "I DON'T KNOW",
            "  I don't know  ",
            "I don't know.",
            "I don't know!",
            "I don't know?",
            "I don't know...",
            "I don’t know",  # smart apostrophe
            "I don’t know.",
        ],
    )
    def test_matches_the_abstention_phrase(self, answer):
        assert is_abstention(answer)

    @pytest.mark.parametrize(
        "answer",
        [
            "",
            "13 years old.",
            "I don't know the answer",
            "I don't know, the context does not say",
            # The known Opus verbose refusal. It is NOT matched, which is why 10.4
            # recall is reported as a lower bound rather than as a measurement.
            "I don't know. The provided context does not mention any governing law.",
        ],
    )
    def test_does_not_match_anything_else(self, answer):
        assert not is_abstention(answer)


class TestShapeAssertion:
    def test_accepts_a_complete_frame(self):
        assert_phase2_shape(make_rows())

    def test_rejects_an_empty_frame(self):
        with pytest.raises(ShapeError, match="no Phase-2 rows"):
            assert_phase2_shape([])

    def test_rejects_a_missing_arm(self):
        rows = [r for r in make_rows() if r.model == TREATMENT_MODEL]
        with pytest.raises(ShapeError, match="expected models"):
            assert_phase2_shape(rows)

    def test_rejects_an_arm_missing_one_question(self):
        # A missing pair silently drops from a paired test and shrinks n without error.
        rows = [
            r
            for r in make_rows()
            if not (r.model == BASELINE_MODEL and r.question_id == "q05")
        ]
        with pytest.raises(ShapeError, match="does not cover the same question set|questions per model"):
            assert_phase2_shape(rows)

    def test_rejects_duplicate_runs(self):
        rows = make_rows()
        with pytest.raises(ShapeError):
            assert_phase2_shape(rows + [rows[0]])

    def test_accepts_an_explicit_grid_size(self):
        assert_phase2_shape(make_rows(questions=SMALL_QUESTIONS), expected_questions=10)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: FAIL at collection with `ModuleNotFoundError` / `ImportError: cannot import name 'Phase2Row' from 'tosrag_analysis.phase2'`.

- [ ] **Step 3: Write the module foundations**

Create `analysis/src/tosrag_analysis/phase2.py`:

```python
"""Phase-2 analyses — pure composition: rows in, one payload out.

Phase 2 is the project's only two-arm comparison: one frozen configuration
(`sentence:512`), two generators, the same 30 questions, the same retrieval. Every
difference between the arms is therefore attributable to generation, which is what
makes a paired test the right instrument.

No database access lives here, so every payload is reproducible from a fixture frame —
the same split `phase1.py` makes, and the same split `plan-ingest.ts` makes on the
ingestion path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

import numpy as np

from .phase1 import ShapeError
from .stats import clean_values, estimate, holm, paired_wilcoxon

# Re-exported so callers can catch one shape error for either phase; `cli.py` has a
# single `except ShapeError` and should not have to know which module raised.
__all__ = ["ShapeError"]

# PRD 8: the two generators. `TREATMENT` is the hosted model under test and
# `BASELINE` the local one it is compared against; every difference in this module is
# oriented treatment - baseline, so a positive difference always means Opus ahead.
TREATMENT_MODEL = "claude-opus-4-8"
BASELINE_MODEL = "llama3.1:8b"
EXPECTED_MODELS: tuple[str, str] = (TREATMENT_MODEL, BASELINE_MODEL)
EXPECTED_QUESTIONS = 30  # the full question set, Round 1 (20) + held-out (10)

UNANSWERABLE_QTYPE = "unanswerable"

# The headline metric. Truthfulness = mean CRAG score in {-1, 0, +1}
# = accuracy_rate - hallucination_rate (PRD 10.3).
HEADLINE_METRIC = "crag_score"

# The Holm family: metrics that generation can actually move. Retrieval metrics are
# excluded deliberately — see RETRIEVAL_METRICS.
TESTED_METRICS: tuple[str, ...] = (
    "crag_score",
    "faithfulness",
    "cosine_sim",
    "squad_f1",
    "squad_em",
)

# Reported, never tested. Both arms share one frozen config, k, embedder and query, so
# these are identical per question by construction; a paired test on them is degenerate
# and would only inflate the Holm correction that the real comparisons have to pay.
RETRIEVAL_METRICS: tuple[str, ...] = ("char_precision", "char_recall", "hit_at_8")

METRIC_NOTES: dict[str, str] = {
    "crag_score": "Truthfulness: mean CRAG judge score in {-1,0,+1} (PRD 10.3). Headline metric.",
    "faithfulness": "Supported statements / total, against the retrieved context (PRD 10.2). "
    "NULL for abstentions and for answers that decompose to zero statements, so it has "
    "fewer complete pairs than the other metrics.",
    "cosine_sim": "Cosine between embeddings of the generated and the expected answer "
    "(PRD 10.5). Both sides use the document prefix: this is an answer-vs-answer "
    "comparison, not query-vs-document.",
    "squad_f1": "SQuAD token-overlap F1. Rewards terse answers, so it does not track "
    "Truthfulness here — reported because a metric that disagrees is evidence, not noise.",
    "squad_em": "SQuAD exact match. Same terseness caveat as squad_f1.",
}

RETRIEVAL_METRIC_NOTES: dict[str, str] = {
    "char_precision": "Char-span precision; NULL for unanswerable questions (PRD 10.1). "
    "Intrinsically low: chunks are far larger than gold spans.",
    "char_recall": "Char-span recall; NULL for unanswerable questions (PRD 10.1).",
    "hit_at_8": "Hit rate at k=5. Column name is legacy (k was reduced from 8; PRD 15 #11).",
}

ABSTENTION_TEXT = "i don't know"

_SMART_QUOTES = str.maketrans({"’": "'", "‘": "'"})


@dataclass(frozen=True)
class Phase2Row:
    """One (model, question) observation: a `runs` row joined to its `evals` row."""

    model: str
    question_id: str
    qtype: str
    held_out: bool
    answer: str
    crag_score: float | None = None
    faithfulness: float | None = None
    cosine_sim: float | None = None
    squad_f1: float | None = None
    squad_em: float | None = None
    char_precision: float | None = None
    char_recall: float | None = None
    hit_at_8: float | None = None
    retrieval_ms: float | None = None
    generation_ms: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None

    def metric(self, name: str) -> float | None:
        return getattr(self, name)


def is_abstention(answer: str) -> bool:
    """True iff the answer is the abstention phrase (PRD 10.6).

    A cross-language copy of `isAbstention` in `packages/core/src/prompts.ts` and must
    stay in sync with it, the same way JUDGED_QUERY's sentinels copy RULE_EXPLANATIONS.
    Trailing punctuation is ignored because SQuAD's `normalizeAnswer` strips it too:
    when the two disagreed, "I don't know." and "I don't know" took different branches
    of the CRAG decision order and scored a full point apart (see the 2026-08-01 entry
    in docs/report-notes.md).

    The match is exact, so a verbose refusal is *not* an abstention here. That makes
    10.4 recall a lower bound, which `build_abstention` states rather than hides.
    """
    return (
        answer.translate(_SMART_QUOTES).strip().rstrip(".!?").strip().lower()
        == ABSTENTION_TEXT
    )


def assert_phase2_shape(
    rows: Sequence[Phase2Row],
    expected_models: Sequence[str] = EXPECTED_MODELS,
    expected_questions: int = EXPECTED_QUESTIONS,
) -> None:
    """Fail loudly before computing anything.

    A missing pair does not error in a paired test — it silently shrinks n and shifts
    every mean. Same reasoning as `assert_phase1_shape`.
    """
    if not rows:
        raise ShapeError("no Phase-2 rows found — has run-phase2 been run against this database?")

    models = sorted({r.model for r in rows})
    if models != sorted(expected_models):
        raise ShapeError(f"expected models {sorted(expected_models)}, found {models}")

    questions_by_model = {m: sorted(r.question_id for r in rows if r.model == m) for m in models}
    reference = questions_by_model[models[0]]
    if len(reference) != expected_questions:
        raise ShapeError(
            f"expected {expected_questions} questions per model, "
            f"model {models[0]} has {len(reference)}"
        )
    for model, questions in questions_by_model.items():
        if questions != reference:
            missing = sorted(set(reference) - set(questions))
            extra = sorted(set(questions) - set(reference))
            raise ShapeError(
                f"model {model} does not cover the same question set as {models[0]} "
                f"(missing: {missing}, unexpected: {extra}) — the paired test requires identical pairing"
            )

    if len(rows) != len(expected_models) * expected_questions:
        raise ShapeError(
            f"expected {len(expected_models) * expected_questions} rows, got {len(rows)} "
            "(duplicate runs for the same model/question?)"
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: PASS — 21 tests (16 parametrised abstention cases + 6 shape cases minus overlap; the exact count is whatever collection reports, and all must be green).

- [ ] **Step 5: Stage, do not commit**

```bash
git add analysis/src/tosrag_analysis/phase2.py analysis/tests/test_phase2.py
# Do not commit yet — see Global Constraints. Proposed message:
# feat(analysis): add Phase-2 row type, abstention predicate, and shape assertion
```

---

### Task 2: Pairing and the paired comparisons block

**Files:**
- Modify: `analysis/src/tosrag_analysis/phase2.py` (append)
- Modify: `analysis/tests/test_phase2.py` (append)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `PairedMetric` frozen dataclass with fields `metric: str`, `a: list[float]`, `b: list[float]`, `used: list[str]`, `dropped: list[str]` — `a` is `TREATMENT_MODEL`, `b` is `BASELINE_MODEL`, both aligned by question id.
  - `pair_metric(rows: Sequence[Phase2Row], metric: str) -> PairedMetric`
  - `build_paired_comparisons(rows: Sequence[Phase2Row], alpha: float = 0.05) -> dict`
  - `build_win_counts(rows: Sequence[Phase2Row], metric: str = HEADLINE_METRIC) -> dict`
  - Private helpers `_by_model`, `_values`, `_mean_or_none` used by later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `analysis/tests/test_phase2.py` — and extend the import block at the top of the file to add `build_paired_comparisons`, `build_win_counts`, and `pair_metric`:

```python
class TestPairing:
    def test_pairs_are_aligned_by_question(self):
        rows = make_rows(
            score_for=lambda model, qid: 1.0 if model == TREATMENT_MODEL else -1.0,
            questions=SMALL_QUESTIONS,
        )
        pair = pair_metric(rows, "crag_score")
        assert pair.used == SMALL_QUESTIONS
        assert pair.dropped == []
        assert pair.a == [1.0] * 10
        assert pair.b == [-1.0] * 10

    def test_a_null_on_either_arm_drops_that_pair_and_records_it(self):
        # Faithfulness is NULL for abstentions by design, so pairwise deletion is
        # correct here — but the count must be reported, never silently absorbed.
        rows = make_rows(questions=SMALL_QUESTIONS)
        pair = pair_metric(rows, "faithfulness")
        assert pair.dropped == SMALL_QUESTIONS[-UNANSWERABLE_COUNT:]
        assert len(pair.used) == 10 - UNANSWERABLE_COUNT
        assert len(pair.a) == len(pair.b) == len(pair.used)

    def test_a_null_on_only_one_arm_still_drops_the_pair(self):
        rows = [
            Phase2Row(**{**r.__dict__, "cosine_sim": None})
            if (r.model == BASELINE_MODEL and r.question_id == "q02")
            else r
            for r in make_rows(questions=SMALL_QUESTIONS)
        ]
        pair = pair_metric(rows, "cosine_sim")
        assert pair.dropped == ["q02"]
        assert "q02" not in pair.used

    def test_a_null_headline_score_is_rejected_not_dropped(self):
        # 0.0 is a real CRAG score (Missing/abstention). Dropping a NULL here would
        # quietly shrink n; coercing it would fabricate an abstention.
        rows = [
            Phase2Row(**{**r.__dict__, "crag_score": None})
            if (r.model == TREATMENT_MODEL and r.question_id == "q03")
            else r
            for r in make_rows(questions=SMALL_QUESTIONS)
        ]
        with pytest.raises(ShapeError, match="real CRAG score"):
            pair_metric(rows, "crag_score")


class TestWinCounts:
    def test_counts_wins_losses_and_ties(self):
        rows = make_rows(
            score_for=lambda model, qid: (
                1.0 if qid in ("q00", "q01") else (0.0 if qid == "q02" else 1.0)
            )
            if model == TREATMENT_MODEL
            else (0.0 if qid in ("q00", "q01") else (1.0 if qid == "q02" else 1.0)),
            questions=SMALL_QUESTIONS,
        )
        counts = build_win_counts(rows)
        assert counts["wins"][TREATMENT_MODEL] == 2
        assert counts["wins"][BASELINE_MODEL] == 1
        assert counts["ties"] == 7
        assert counts["n_pairs"] == 10


@pytest.fixture(scope="module")
def separated_comparisons():
    """A clean 2-point separation on every question, at n = 10 (exhaustive permutation)."""
    rows = make_rows(
        score_for=lambda model, qid: 1.0 if model == TREATMENT_MODEL else -1.0,
        questions=SMALL_QUESTIONS,
    )
    return build_paired_comparisons(rows)


class TestPairedComparisons:
    def test_reports_every_tested_metric(self, separated_comparisons):
        metrics = [e["metric"] for e in separated_comparisons["metrics"]]
        assert metrics == list(TESTED_METRICS)

    def test_holm_adjusted_p_is_never_below_raw(self, separated_comparisons):
        for entry in separated_comparisons["metrics"]:
            if entry["p_raw"] is not None:
                assert entry["p_holm"] >= entry["p_raw"]

    def test_a_real_separation_is_detected(self, separated_comparisons):
        crag = next(e for e in separated_comparisons["metrics"] if e["metric"] == "crag_score")
        assert crag["significant"]
        assert crag["difference"]["mean"]["mean"] == pytest.approx(2.0)
        assert crag["means"][TREATMENT_MODEL] == pytest.approx(1.0)
        assert crag["means"][BASELINE_MODEL] == pytest.approx(-1.0)

    def test_identical_arms_are_not_separable(self):
        rows = make_rows(score_for=lambda model, qid: 1.0, questions=SMALL_QUESTIONS)
        payload = build_paired_comparisons(rows)
        assert payload["n_significant"] == 0
        crag = next(e for e in payload["metrics"] if e["metric"] == "crag_score")
        assert crag["wilcoxon"]["ties"] == 10
        assert crag["p_raw"] == 1.0

    def test_dropped_pairs_are_surfaced_per_metric(self, separated_comparisons):
        faith = next(e for e in separated_comparisons["metrics"] if e["metric"] == "faithfulness")
        assert faith["n_pairs_dropped"] == UNANSWERABLE_COUNT
        assert faith["n_pairs_used"] == 10 - UNANSWERABLE_COUNT
        assert faith["dropped_question_ids"] == SMALL_QUESTIONS[-UNANSWERABLE_COUNT:]

    def test_a_metric_with_too_few_pairs_is_omitted_from_the_family(self):
        # Every faithfulness value NULL -> no pairs -> no test, and it must not enter
        # the Holm family, where it would tax the metrics that were actually tested.
        rows = [
            Phase2Row(**{**r.__dict__, "faithfulness": None})
            for r in make_rows(questions=SMALL_QUESTIONS)
        ]
        payload = build_paired_comparisons(rows)
        faith = next(e for e in payload["metrics"] if e["metric"] == "faithfulness")
        assert faith["p_raw"] is None
        assert faith["p_holm"] is None
        assert faith["significant"] is False
        assert "complete pairs" in faith["omitted_reason"]
        assert "faithfulness" not in payload["family"]
        assert payload["n_comparisons"] == len(TESTED_METRICS) - 1
```

Also extend the top-of-file import to include `TESTED_METRICS`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: FAIL with `ImportError: cannot import name 'pair_metric' from 'tosrag_analysis.phase2'`.

- [ ] **Step 3: Write the implementation**

Append to `analysis/src/tosrag_analysis/phase2.py`:

```python
def _by_model(rows: Sequence[Phase2Row]) -> dict[str, list[Phase2Row]]:
    grouped: dict[str, list[Phase2Row]] = {}
    for row in rows:
        grouped.setdefault(row.model, []).append(row)
    return {model: sorted(rs, key=lambda r: r.question_id) for model, rs in grouped.items()}


def _values(rows: Iterable[Phase2Row], metric: str) -> list[float | None]:
    return [r.metric(metric) for r in rows]


def _mean_or_none(values: Iterable[float | None]) -> float | None:
    present = clean_values(values)
    return float(present.mean()) if present.size else None


@dataclass(frozen=True)
class PairedMetric:
    """Question-aligned vectors for one metric, plus the pairs that could not be used.

    `a` is always the treatment arm and `b` the baseline, so `a - b > 0` means the
    treatment is ahead everywhere in this module.
    """

    metric: str
    a: list[float]
    b: list[float]
    used: list[str]
    dropped: list[str]


def pair_metric(rows: Sequence[Phase2Row], metric: str) -> PairedMetric:
    """Align both arms by question, dropping pairs a NULL makes unusable.

    Pairwise deletion is correct for `faithfulness`, which is NULL by design for
    abstentions and zero-statement answers — but never for the headline metric, where
    0 is a real score, so a NULL there is a data defect and raises instead.
    """
    grouped = _by_model(rows)
    treatment = {r.question_id: r.metric(metric) for r in grouped.get(TREATMENT_MODEL, [])}
    baseline = {r.question_id: r.metric(metric) for r in grouped.get(BASELINE_MODEL, [])}
    question_ids = sorted({r.question_id for r in rows})

    a_values: list[float] = []
    b_values: list[float] = []
    used: list[str] = []
    dropped: list[str] = []
    for qid in question_ids:
        a = treatment.get(qid)
        b = baseline.get(qid)
        if a is None or b is None:
            dropped.append(qid)
            continue
        a_values.append(float(a))
        b_values.append(float(b))
        used.append(qid)

    if metric == HEADLINE_METRIC and dropped:
        raise ShapeError(
            f"{metric} is NULL for {dropped} — 0 is a real CRAG score (Missing/abstention), "
            "so a missing headline value must never be dropped or coerced"
        )

    return PairedMetric(metric=metric, a=a_values, b=b_values, used=used, dropped=dropped)


def build_win_counts(rows: Sequence[Phase2Row], metric: str = HEADLINE_METRIC) -> dict:
    """Per-question wins, losses and ties — the sign pattern behind the Wilcoxon p."""
    pair = pair_metric(rows, metric)
    differences = [a - b for a, b in zip(pair.a, pair.b)]
    return {
        "metric": metric,
        "direction": f"{TREATMENT_MODEL} minus {BASELINE_MODEL}",
        "n_pairs": len(differences),
        "wins": {
            TREATMENT_MODEL: sum(1 for d in differences if d > 0),
            BASELINE_MODEL: sum(1 for d in differences if d < 0),
        },
        "ties": sum(1 for d in differences if d == 0),
    }


def build_paired_comparisons(rows: Sequence[Phase2Row], alpha: float = 0.05) -> dict:
    """Paired Wilcoxon per tested metric, Holm-corrected across the family (PRD 11).

    Holm is applied across the tested metrics only. Retrieval metrics are excluded
    because both arms share one retrieval, so testing them would add degenerate
    comparisons that make the real ones harder to detect.
    """
    entries: list[dict] = []
    for metric in TESTED_METRICS:
        pair = pair_metric(rows, metric)
        entry: dict = {
            "metric": metric,
            "note": METRIC_NOTES[metric],
            "means": {
                TREATMENT_MODEL: _mean_or_none(pair.a),
                BASELINE_MODEL: _mean_or_none(pair.b),
            },
            "n_pairs_used": len(pair.used),
            "n_pairs_dropped": len(pair.dropped),
            "dropped_question_ids": pair.dropped,
        }

        if len(pair.used) < 2:
            entry.update(
                {
                    "difference": None,
                    "wilcoxon": None,
                    "p_raw": None,
                    "omitted_reason": (
                        f"only {len(pair.used)} complete pairs (need at least 2)"
                    ),
                }
            )
        else:
            differences = [a - b for a, b in zip(pair.a, pair.b)]
            result = paired_wilcoxon(pair.a, pair.b)
            entry.update(
                {
                    "difference": {
                        "direction": f"{TREATMENT_MODEL} minus {BASELINE_MODEL}",
                        "mean": estimate(differences).as_dict(),
                        "median": float(np.median(differences)),
                    },
                    "wilcoxon": result.as_dict(),
                    "p_raw": result.p_value,
                    "omitted_reason": None,
                }
            )
        entries.append(entry)

    tested = [e for e in entries if e["p_raw"] is not None]
    for entry, p_holm in zip(tested, holm([e["p_raw"] for e in tested])):
        entry["p_holm"] = p_holm
        entry["significant"] = p_holm < alpha
    for entry in entries:
        entry.setdefault("p_holm", None)
        entry.setdefault("significant", False)

    n_significant = sum(1 for e in entries if e["significant"])
    return {
        "test": "paired Wilcoxon signed-rank, two-sided, zero_method=zsplit",
        "permutation": "seeded Monte Carlo above 20 pairs, exhaustive at or below (PRD 11)",
        "direction": (
            f"{TREATMENT_MODEL} minus {BASELINE_MODEL}; in `wilcoxon`, "
            f"wins = {TREATMENT_MODEL} ahead"
        ),
        "correction": "holm",
        "alpha": alpha,
        "family": [e["metric"] for e in tested],
        "n_comparisons": len(tested),
        "n_significant": n_significant,
        "interpretation": (
            f"{TREATMENT_MODEL} is separable from {BASELINE_MODEL} on {n_significant} of "
            f"{len(tested)} tested metrics after Holm correction at alpha = {alpha}."
        ),
        "metrics": entries,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: PASS, all tests green.

- [ ] **Step 5: Stage, do not commit**

```bash
git add analysis/src/tosrag_analysis/phase2.py analysis/tests/test_phase2.py
# Do not commit yet — see Global Constraints. Proposed message:
# feat(analysis): add Phase-2 pairing and Holm-corrected paired comparisons
```

---

### Task 3: Arm summaries, retrieval identity, abstention precision/recall

**Files:**
- Modify: `analysis/src/tosrag_analysis/phase2.py` (append)
- Modify: `analysis/tests/test_phase2.py` (append)

**Interfaces:**
- Consumes: `_by_model`, `_values`, `_mean_or_none`, `pair_metric` from Task 2.
- Produces:
  - `build_arm_summary(rows: Sequence[Phase2Row]) -> dict` — keyed by model id
  - `build_retrieval_identity(rows: Sequence[Phase2Row]) -> dict`
  - `build_abstention(rows: Sequence[Phase2Row]) -> dict`

- [ ] **Step 1: Write the failing tests**

Append to `analysis/tests/test_phase2.py`, extending the import block with `build_abstention`, `build_arm_summary`, `build_retrieval_identity`:

```python
class TestArmSummary:
    def test_reports_both_arms_with_metrics_latency_and_cost(self):
        summary = build_arm_summary(make_rows(questions=SMALL_QUESTIONS))
        assert set(summary) == {TREATMENT_MODEL, BASELINE_MODEL}

        treatment = summary[TREATMENT_MODEL]
        assert treatment["n_runs"] == 10
        assert set(treatment["metrics"]) == set(TESTED_METRICS)
        assert treatment["metrics"]["crag_score"]["mean"] == pytest.approx(1.0)
        # Faithfulness is NULL on the unanswerable questions, so its n is lower and
        # the payload carries that n rather than a single frame-wide count.
        assert treatment["metrics"]["faithfulness"]["n"] == 10 - UNANSWERABLE_COUNT
        assert treatment["metrics"]["crag_score"]["n"] == 10

    def test_latency_is_split_by_stage(self):
        summary = build_arm_summary(make_rows(questions=SMALL_QUESTIONS))
        latency = summary[TREATMENT_MODEL]["latency_ms"]
        assert set(latency) == {"retrieval_ms", "generation_ms"}
        assert latency["generation_ms"]["median"] == pytest.approx(1000.0)
        assert latency["generation_ms"]["p95"] == pytest.approx(1000.0)
        assert latency["retrieval_ms"]["n"] == 10

    def test_cost_totals_and_token_counts(self):
        summary = build_arm_summary(make_rows(questions=SMALL_QUESTIONS))
        assert summary[TREATMENT_MODEL]["cost"]["total_usd"] == pytest.approx(0.2)
        assert summary[TREATMENT_MODEL]["cost"]["mean_usd_per_run"] == pytest.approx(0.02)
        assert summary[TREATMENT_MODEL]["cost"]["input_tokens"] == 1000
        assert summary[TREATMENT_MODEL]["cost"]["output_tokens"] == 200
        # A locally served model costs $0 in API terms, and that is the finding, not
        # a missing measurement — so it is 0.0, never None.
        assert summary[BASELINE_MODEL]["cost"]["total_usd"] == pytest.approx(0.0)


class TestRetrievalIdentity:
    def test_identical_retrieval_is_detected(self):
        payload = build_retrieval_identity(make_rows(questions=SMALL_QUESTIONS))
        assert payload["identical"] is True
        assert set(payload["metrics"]) == set(RETRIEVAL_METRICS)
        assert payload["metrics"]["char_recall"]["n_differing"] == 0
        assert payload["metrics"]["char_recall"]["shared_estimate"]["mean"] == pytest.approx(0.99)

    def test_a_difference_is_reported_not_raised(self):
        # If the arms ever diverge on retrieval, that is a finding about the data, and
        # the report's "the difference is generation-only" claim would be wrong. It
        # must surface as a measurement, not as a crash and not as a silent pass.
        rows = [
            Phase2Row(**{**r.__dict__, "char_recall": 0.1})
            if (r.model == BASELINE_MODEL and r.question_id == "q04")
            else r
            for r in make_rows(questions=SMALL_QUESTIONS)
        ]
        payload = build_retrieval_identity(rows)
        assert payload["identical"] is False
        assert payload["metrics"]["char_recall"]["identical"] is False
        assert payload["metrics"]["char_recall"]["differing_question_ids"] == ["q04"]


class TestAbstention:
    def test_perfect_abstention_scores_one_and_one(self):
        payload = build_abstention(make_rows(questions=SMALL_QUESTIONS))
        entry = payload["models"][TREATMENT_MODEL]
        assert entry["n_unanswerable"] == UNANSWERABLE_COUNT
        assert entry["n_abstained"] == UNANSWERABLE_COUNT
        assert entry["recall"] == pytest.approx(1.0)
        assert entry["precision"] == pytest.approx(1.0)
        assert entry["missed_question_ids"] == []
        assert entry["false_abstention_question_ids"] == []

    def test_a_missed_abstention_lowers_recall_and_is_named(self):
        missed = SMALL_QUESTIONS[-1]
        rows = make_rows(
            questions=SMALL_QUESTIONS,
            answer_for=lambda model, qid: (
                "The context does not say."
                if (model == TREATMENT_MODEL and qid == missed)
                else ("I don't know" if qid in SMALL_QUESTIONS[-UNANSWERABLE_COUNT:] else "text")
            ),
        )
        entry = build_abstention(rows)["models"][TREATMENT_MODEL]
        assert entry["recall"] == pytest.approx((UNANSWERABLE_COUNT - 1) / UNANSWERABLE_COUNT)
        assert entry["missed_question_ids"] == [missed]
        assert entry["precision"] == pytest.approx(1.0)

    def test_abstaining_on_an_answerable_question_lowers_precision(self):
        rows = make_rows(
            questions=SMALL_QUESTIONS,
            answer_for=lambda model, qid: (
                "I don't know"
                if qid in SMALL_QUESTIONS[-UNANSWERABLE_COUNT:] or qid == "q00"
                else "text"
            ),
        )
        entry = build_abstention(rows)["models"][TREATMENT_MODEL]
        assert entry["n_abstained"] == UNANSWERABLE_COUNT + 1
        assert entry["precision"] == pytest.approx(UNANSWERABLE_COUNT / (UNANSWERABLE_COUNT + 1))
        assert entry["false_abstention_question_ids"] == ["q00"]

    def test_precision_is_undefined_when_the_arm_never_abstains(self):
        rows = make_rows(questions=SMALL_QUESTIONS, answer_for=lambda model, qid: "text")
        entry = build_abstention(rows)["models"][TREATMENT_MODEL]
        assert entry["precision"] is None
        assert "never abstained" in entry["precision_omitted_reason"]
        assert entry["recall"] == pytest.approx(0.0)

    def test_recall_is_undefined_with_no_unanswerable_questions(self):
        # This is the real held-out subset: 10 questions, none unanswerable. A 0.0
        # here would read as "the model never abstained when it should have".
        rows = [r for r in make_rows(questions=SMALL_QUESTIONS) if r.qtype != "unanswerable"]
        entry = build_abstention(rows)["models"][TREATMENT_MODEL]
        assert entry["recall"] is None
        assert "no unanswerable questions" in entry["recall_omitted_reason"]

    def test_the_detector_caveat_ships_with_the_numbers(self):
        payload = build_abstention(make_rows(questions=SMALL_QUESTIONS))
        assert "lower bound" in payload["detector_caveat"]
```

Extend the top-of-file import to include `RETRIEVAL_METRICS`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_arm_summary' from 'tosrag_analysis.phase2'`.

- [ ] **Step 3: Write the implementation**

Append to `analysis/src/tosrag_analysis/phase2.py`:

```python
def _percentile(values: Iterable[float | None], q: float) -> float | None:
    arr = clean_values(values)
    return float(np.percentile(arr, q)) if arr.size else None


def _sum_int(rows: Iterable[Phase2Row], field: str) -> int | None:
    present = [getattr(r, field) for r in rows if getattr(r, field) is not None]
    return int(sum(present)) if present else None


def build_arm_summary(rows: Sequence[Phase2Row]) -> dict:
    """Per model: metric estimates, latency by stage, cost and tokens.

    Latency is median + p95 per PRD 10.5 rather than a mean, because a single slow
    generation dominates a mean at n = 30 and the report needs the typical case and
    the tail stated separately.
    """
    summary: dict[str, dict] = {}
    for model, model_rows in sorted(_by_model(rows).items()):
        priced = [r.cost_usd for r in model_rows if r.cost_usd is not None]
        summary[model] = {
            "n_runs": len(model_rows),
            "metrics": {
                metric: estimate(_values(model_rows, metric)).as_dict()
                for metric in TESTED_METRICS
            },
            "latency_ms": {
                stage: {
                    "median": _percentile(_values(model_rows, stage), 50),
                    "p95": _percentile(_values(model_rows, stage), 95),
                    "n": int(clean_values(_values(model_rows, stage)).size),
                }
                for stage in ("retrieval_ms", "generation_ms")
            },
            "cost": {
                "total_usd": float(sum(priced)) if priced else None,
                "mean_usd_per_run": float(sum(priced) / len(priced)) if priced else None,
                "n_priced_runs": len(priced),
                "input_tokens": _sum_int(model_rows, "input_tokens"),
                "output_tokens": _sum_int(model_rows, "output_tokens"),
            },
        }
    return summary


def build_retrieval_identity(rows: Sequence[Phase2Row]) -> dict:
    """Check, rather than assume, that both arms retrieved the same spans.

    "The difference is generation-only" is the load-bearing claim of Chapter 6. It rests
    on both arms sharing one frozen config, k, embedder and query — which is true by
    construction, and is therefore exactly the kind of assumption worth measuring. A
    divergence is reported as a finding, not raised: the payload would then be evidence
    that the claim is wrong, which is more useful than a crash.
    """
    grouped = _by_model(rows)
    question_ids = sorted({r.question_id for r in rows})

    metrics: dict[str, dict] = {}
    for metric in RETRIEVAL_METRICS:
        treatment = {r.question_id: r.metric(metric) for r in grouped.get(TREATMENT_MODEL, [])}
        baseline = {r.question_id: r.metric(metric) for r in grouped.get(BASELINE_MODEL, [])}
        differing = [qid for qid in question_ids if treatment.get(qid) != baseline.get(qid)]
        metrics[metric] = {
            "identical": not differing,
            "n_differing": len(differing),
            "differing_question_ids": differing,
            "shared_estimate": estimate(
                [treatment.get(qid) for qid in question_ids]
            ).as_dict(),
            "note": RETRIEVAL_METRIC_NOTES[metric],
        }

    return {
        "claim": (
            "both arms retrieved under the same frozen config, k, embedder and query, so "
            "retrieval metrics should be identical per question and any difference between "
            "the arms is generation-only"
        ),
        "identical": all(m["identical"] for m in metrics.values()),
        "excluded_from_tested_family": (
            "identical per question by construction, so a paired test on these is "
            "degenerate and would only inflate the Holm correction"
        ),
        "metrics": metrics,
    }


def build_abstention(rows: Sequence[Phase2Row]) -> dict:
    """Abstention precision and recall per arm (PRD 10.4).

    Abstention is detected from the answer text, never from `judge_explanation`: since
    the 2026-08-02 amendment (PRD 15 #12) `cragScore` checks normalized exact match
    first, so a correct "I don't know" on an unanswerable question is labelled
    `exact match`, and the `abstained` label is 0 on all 360 rows.
    """
    entries: dict[str, dict] = {}
    for model, model_rows in sorted(_by_model(rows).items()):
        unanswerable = [r for r in model_rows if r.qtype == UNANSWERABLE_QTYPE]
        abstained = [r for r in model_rows if is_abstention(r.answer)]
        correct = [r for r in abstained if r.qtype == UNANSWERABLE_QTYPE]

        entries[model] = {
            "n_runs": len(model_rows),
            "n_unanswerable": len(unanswerable),
            "n_abstained": len(abstained),
            "n_correct_abstentions": len(correct),
            "recall": len(correct) / len(unanswerable) if unanswerable else None,
            "recall_omitted_reason": (
                None if unanswerable else "no unanswerable questions in this subset"
            ),
            "precision": len(correct) / len(abstained) if abstained else None,
            "precision_omitted_reason": (None if abstained else "this arm never abstained"),
            "missed_question_ids": sorted(
                r.question_id for r in unanswerable if not is_abstention(r.answer)
            ),
            "false_abstention_question_ids": sorted(
                r.question_id for r in abstained if r.qtype != UNANSWERABLE_QTYPE
            ),
        }

    return {
        "definition": (
            "over unanswerable questions: recall = fraction answered \"I don't know\"; "
            "precision = of all \"I don't know\" replies, the fraction that were truly "
            "unanswerable (PRD 10.4)"
        ),
        "detector": (
            "answer text via is_abstention, a cross-language copy of isAbstention in "
            "packages/core/src/prompts.ts — not judge_explanation, which is 'abstained' "
            "on no rows since the PRD 15 #12 amendment"
        ),
        "detector_caveat": (
            "the predicate matches only the exact phrase, ignoring case, smart quotes and "
            "trailing sentence punctuation. A verbose refusal is counted as a "
            "non-abstention, so recall is a lower bound — see missed_question_ids"
        ),
        "models": entries,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: PASS, all tests green.

- [ ] **Step 5: Stage, do not commit**

```bash
git add analysis/src/tosrag_analysis/phase2.py analysis/tests/test_phase2.py
# Do not commit yet — see Global Constraints. Proposed message:
# feat(analysis): add Phase-2 arm summaries, retrieval identity check, abstention P/R
```

---

### Task 4: Subset reporting and the `phase2_paired` payload

**Files:**
- Modify: `analysis/src/tosrag_analysis/phase2.py` (append)
- Modify: `analysis/tests/test_phase2.py` (append)

**Interfaces:**
- Consumes: every builder from Tasks 2 and 3.
- Produces:
  - `build_subset(rows: Sequence[Phase2Row], label: str, description: str) -> dict`
  - `build_paired_analysis(rows: Sequence[Phase2Row], alpha: float = 0.05) -> dict`
  - `_BUILDERS: dict[str, Callable[[Sequence[Phase2Row]], dict]]`
  - `ANALYSIS_KEYS: tuple[str, ...] = ("phase2_paired",)`
  - `build_all(rows, expected_models=EXPECTED_MODELS, expected_questions=EXPECTED_QUESTIONS) -> dict[str, dict]`

- [ ] **Step 1: Write the failing tests**

Append to `analysis/tests/test_phase2.py`, extending the import block with `ANALYSIS_KEYS`, `build_all`, `build_paired_analysis`, `build_subset`:

```python
class TestSubsets:
    def test_a_subset_is_descriptive_only(self):
        rows = [r for r in make_rows(questions=SMALL_QUESTIONS) if r.held_out]
        payload = build_subset(rows, "held_out", "the held-out questions")
        assert payload["label"] == "held_out"
        assert payload["inferential"] is False
        assert "no inferential claim" in payload["why_descriptive_only"]
        assert payload["n_questions"] == HELD_OUT_COUNT
        # No p-value anywhere in a subset: n is too small to support one, and printing
        # one would invite exactly the reading the caveat exists to prevent.
        assert "p_raw" not in payload
        assert "wilcoxon" not in payload

    def test_a_subset_still_carries_means_and_win_counts(self):
        rows = [r for r in make_rows(questions=SMALL_QUESTIONS) if r.held_out]
        payload = build_subset(rows, "held_out", "the held-out questions")
        assert payload["means"][TREATMENT_MODEL]["mean"] == pytest.approx(1.0)
        assert payload["means"][BASELINE_MODEL]["mean"] == pytest.approx(0.0)
        assert payload["win_counts"]["wins"][TREATMENT_MODEL] == HELD_OUT_COUNT


@pytest.fixture(scope="module")
def full_payload():
    """The real 2 x 30 Phase-2 frame, built once — this is the expensive path."""
    return build_all(make_rows())


class TestBuildAll:
    def test_produces_every_analysis_key(self, full_payload):
        assert set(full_payload) == set(ANALYSIS_KEYS)
        assert ANALYSIS_KEYS == ("phase2_paired",)

    def test_payload_carries_every_spec_section(self, full_payload):
        payload = full_payload["phase2_paired"]
        for section in (
            "models",
            "comparison",
            "headline_metric",
            "n_questions",
            "metric_notes",
            "token_comparability_note",
            "arms",
            "paired",
            "win_counts",
            "retrieval",
            "abstention",
            "subsets",
        ):
            assert section in payload, f"missing payload section: {section}"
        assert payload["n_questions"] == 30
        assert [s["label"] for s in payload["subsets"]] == ["held_out", "phase1_reused"]

    def test_is_json_serialisable(self, full_payload):
        import json

        json.dumps(full_payload)

    def test_rejects_a_frame_that_is_not_phase_two(self):
        with pytest.raises(ShapeError):
            build_all(make_rows(questions=SMALL_QUESTIONS))

    def test_accepts_an_explicit_grid_size(self):
        payloads = build_all(make_rows(questions=SMALL_QUESTIONS), expected_questions=10)
        assert set(payloads) == set(ANALYSIS_KEYS)

    def test_is_deterministic(self):
        import json

        rows = make_rows(questions=SMALL_QUESTIONS)
        first = json.dumps(build_all(rows, expected_questions=10), sort_keys=True)
        second = json.dumps(build_all(rows, expected_questions=10), sort_keys=True)
        assert first == second
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_subset' from 'tosrag_analysis.phase2'`.

- [ ] **Step 3: Write the implementation**

Append to `analysis/src/tosrag_analysis/phase2.py`:

```python
def build_subset(rows: Sequence[Phase2Row], label: str, description: str) -> dict:
    """One question subset, reported descriptively.

    The held-out 10 exist to check that the winner was not overfitted to the questions
    that chose it, and that check is worth making — but n = 10 supports no inferential
    claim, so no p-value is computed here at all. Omitting it is stronger than printing
    it with a caveat attached.
    """
    grouped = _by_model(rows)
    return {
        "label": label,
        "description": description,
        "inferential": False,
        "why_descriptive_only": (
            f"n = {len({r.question_id for r in rows})} questions supports no inferential "
            "claim, so no p-value is computed for this subset"
        ),
        "n_questions": len({r.question_id for r in rows}),
        "metric": HEADLINE_METRIC,
        "means": {
            model: estimate(_values(model_rows, HEADLINE_METRIC)).as_dict()
            for model, model_rows in sorted(grouped.items())
        },
        "win_counts": build_win_counts(rows),
        "abstention": build_abstention(rows),
    }


def build_paired_analysis(rows: Sequence[Phase2Row], alpha: float = 0.05) -> dict:
    """The whole Phase-2 payload, written under `phase2_paired`."""
    held_out = [r for r in rows if r.held_out]
    reused = [r for r in rows if not r.held_out]

    return {
        "models": {"treatment": TREATMENT_MODEL, "baseline": BASELINE_MODEL},
        "comparison": f"{TREATMENT_MODEL} minus {BASELINE_MODEL}",
        "headline_metric": HEADLINE_METRIC,
        "n_questions": len({r.question_id for r in rows}),
        "metric_notes": METRIC_NOTES,
        "token_comparability_note": (
            "input/output token counts are not comparable across arms: each model counts "
            "with its own tokenizer, so a byte-identical prompt yields different totals. "
            "They are reported per arm for cost arithmetic, not as a comparison"
        ),
        "cost_note": (
            "the baseline is served locally, so its $0 means 'no marginal API cost' and "
            "excludes hardware and electricity"
        ),
        "arms": build_arm_summary(rows),
        "paired": build_paired_comparisons(rows, alpha),
        "win_counts": build_win_counts(rows),
        "retrieval": build_retrieval_identity(rows),
        "abstention": build_abstention(rows),
        "subsets": [
            build_subset(
                held_out,
                "held_out",
                "questions with questions.phase1 = false — never used to select the "
                "Phase-1 winning configuration",
            ),
            build_subset(
                reused,
                "phase1_reused",
                "questions also used in Phase 1, so the winning configuration was "
                "selected partly on them",
            ),
        ],
    }


# The single registry of Phase-2 analyses: `build_all`'s output and the CLI's `--only`
# choices are both derived from it, so an added or renamed analysis cannot silently
# exist in one and not the other.
_BUILDERS: dict[str, Callable[[Sequence[Phase2Row]], dict]] = {
    "phase2_paired": build_paired_analysis,
}

ANALYSIS_KEYS: tuple[str, ...] = tuple(_BUILDERS)


def build_all(
    rows: Sequence[Phase2Row],
    expected_models: Sequence[str] = EXPECTED_MODELS,
    expected_questions: int = EXPECTED_QUESTIONS,
) -> dict[str, dict]:
    """Every Phase-2 analysis, keyed by its `analysis_results.analysis` value."""
    assert_phase2_shape(rows, expected_models, expected_questions)
    return {key: build(rows) for key, build in _BUILDERS.items()}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd analysis && uv run pytest tests/test_phase2.py -v`
Expected: PASS. The `full_payload` fixture runs 5 seeded Monte Carlo permutation tests at n = 30 plus BCa bootstraps, so this file takes roughly 15–40 s. That is expected; it is built once, module-scoped.

- [ ] **Step 5: Run the whole Python suite**

Run: `cd analysis && uv run pytest -q`
Expected: PASS — the 83 pre-existing tests plus the new Phase-2 file.

- [ ] **Step 6: Stage, do not commit**

```bash
git add analysis/src/tosrag_analysis/phase2.py analysis/tests/test_phase2.py
# Do not commit yet — see Global Constraints. Proposed message:
# feat(analysis): compose the phase2_paired payload with held-out subsets
```

---

### Task 5: The Phase-2 database reader

**Files:**
- Modify: `analysis/src/tosrag_analysis/db.py` — add after `load_phase1_rows` (currently ends at line 132)

**Interfaces:**
- Consumes: `Phase2Row`, `ShapeError` from `.phase2`.
- Produces: `PHASE2_QUERY: str`, `load_phase2_rows(dsn: str) -> list[Phase2Row]`.

**Note on testing:** `db.py` is the only module that touches Postgres and has no hermetic tests, matching the existing `load_phase1_rows` and `load_judged_rows`. It is verified against the live database in Task 7. Everything that must be *correct* lives in `phase2.py` and is tested there.

- [ ] **Step 1: Add the import and the query**

Modify the import block at the top of `analysis/src/tosrag_analysis/db.py`:

```python
from .judge import JudgedRow
from .phase1 import Row
from .phase2 import Phase2Row, ShapeError
```

Then add, after the `PHASE1_QUERY` definition:

```python
# Phase 2 is the two-arm comparison: one config, two models, 30 questions. No
# `config_id` filter is needed now that the superseded recursive:256 rows are deleted
# (2026-08-04), but `load_phase2_rows` asserts a single config is present so a future
# second config cannot silently pool two experiments into one paired test.
PHASE2_QUERY = """
select
  r.config_id,
  r.model,
  r.question_id,
  q.qtype,
  q.phase1,
  r.answer,
  e.crag_score,
  e.faithfulness,
  e.cosine_sim,
  e.squad_f1,
  e.squad_em,
  e.char_precision,
  e.char_recall,
  e.hit_at_8,
  r.retrieval_ms,
  r.generation_ms,
  r.input_tokens,
  r.output_tokens,
  e.cost_usd
from runs r
join evals e on e.run_id = r.id
join questions q on q.id = r.question_id
where r.phase = 2
order by r.model, r.question_id
"""
```

- [ ] **Step 2: Add the reader**

Add after `load_phase1_rows`:

```python
def load_phase2_rows(dsn: str) -> list[Phase2Row]:
    """One Phase2Row per (model, question) for Phase 2."""
    with psycopg.connect(dsn) as connection, connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(PHASE2_QUERY)
        records = cursor.fetchall()

    config_ids = {int(record["config_id"]) for record in records}
    if len(config_ids) > 1:
        # Pooling two configs into one paired test would compare generators *and*
        # pipelines at once, and the payload would not say which produced the gap.
        raise ShapeError(
            f"Phase-2 rows span {len(config_ids)} configs {sorted(config_ids)} — "
            "the paired comparison assumes a single frozen configuration"
        )

    def as_float(value) -> float | None:
        return None if value is None else float(value)

    def as_int(value) -> int | None:
        return None if value is None else int(value)

    # Fields are looked up by column name, so reordering a SELECT column can never
    # silently shift every later value into the wrong slot.
    return [
        Phase2Row(
            model=record["model"],
            question_id=record["question_id"],
            qtype=record["qtype"],
            # `questions.phase1` is true for the 20 questions Phase 1 used, so the
            # held-out set is its complement.
            held_out=not record["phase1"],
            answer=record["answer"] or "",
            crag_score=as_float(record["crag_score"]),
            faithfulness=as_float(record["faithfulness"]),
            cosine_sim=as_float(record["cosine_sim"]),
            squad_f1=as_float(record["squad_f1"]),
            squad_em=as_float(record["squad_em"]),
            char_precision=as_float(record["char_precision"]),
            char_recall=as_float(record["char_recall"]),
            hit_at_8=as_float(record["hit_at_8"]),
            retrieval_ms=as_float(record["retrieval_ms"]),
            generation_ms=as_float(record["generation_ms"]),
            input_tokens=as_int(record["input_tokens"]),
            output_tokens=as_int(record["output_tokens"]),
            # cost_usd is Decimal(10,6) in Postgres; float() here keeps the payload
            # JSON-serialisable, and six decimal places is far inside float precision.
            cost_usd=as_float(record["cost_usd"]),
        )
        for record in records
    ]
```

- [ ] **Step 3: Verify the reader against the live database**

```bash
docker start supabase_db_tos-rag
cd analysis && uv run python -c "
from tosrag_analysis import db
rows = db.load_phase2_rows(db.resolve_dsn())
print('rows', len(rows))
print('models', sorted({r.model for r in rows}))
print('questions', len({r.question_id for r in rows}))
print('held out', len({r.question_id for r in rows if r.held_out}))
print('unanswerable', len({r.question_id for r in rows if r.qtype == 'unanswerable'}))
print('faithfulness nulls', sum(1 for r in rows if r.faithfulness is None))
print('cost nulls', sum(1 for r in rows if r.cost_usd is None))
"
```

Expected, exactly:

```
rows 60
models ['claude-opus-4-8', 'llama3.1:8b']
questions 30
held out 10
unanswerable 4
faithfulness nulls 7
cost nulls 0
```

If any line differs, stop and reconcile against the Verified Ground Truth table before continuing — a shape surprise here means the data moved, not that the code is wrong.

- [ ] **Step 4: Run the Python suite**

Run: `cd analysis && uv run pytest -q`
Expected: PASS — importing `phase2` from `db` must not break the existing tests.

- [ ] **Step 5: Stage, do not commit**

```bash
git add analysis/src/tosrag_analysis/db.py
# Do not commit yet — see Global Constraints. Proposed message:
# feat(analysis): read Phase-2 rows, asserting a single frozen config
```

---

### Task 6: Wire `pnpm analyze` to the Phase-2 key

**Files:**
- Modify: `analysis/src/tosrag_analysis/cli.py:1-115`

**Interfaces:**
- Consumes: `phase2.ANALYSIS_KEYS`, `phase2.build_all`, `db.load_phase2_rows`, `phase1.ShapeError`.
- Produces: no new public API. `analyze` writes `phase1_*` and `phase2_paired`; `--only` selects any key from either phase and loads only the rows that selection needs.

- [ ] **Step 1: Add the Phase-2 summary printer**

In `analysis/src/tosrag_analysis/cli.py`, change the import line `from . import db, phase1` to:

```python
from . import db, phase1, phase2
```

Then add, after `_summarise` (which ends at line 49):

```python
def _summarise_phase2(payload: dict) -> str:
    treatment = payload["models"]["treatment"]
    baseline = payload["models"]["baseline"]
    lines: list[str] = [
        f"Phase 2: {payload['comparison']}  (n = {payload['n_questions']} questions)",
        "",
        f"{'metric':<14}{treatment[:14]:>16}{baseline[:14]:>16}{'p_raw':>9}{'p_holm':>9}{'pairs':>7}",
    ]

    def number(value, spec: str) -> str:
        return "n/a" if value is None else format(value, spec)

    for entry in payload["paired"]["metrics"]:
        lines.append(
            f"{entry['metric']:<14}"
            f"{number(entry['means'][treatment], '>16.4f')}"
            f"{number(entry['means'][baseline], '>16.4f')}"
            f"{number(entry['p_raw'], '>9.4f')}"
            f"{number(entry['p_holm'], '>9.4f')}"
            f"{entry['n_pairs_used']:>7}"
        )

    wins = payload["win_counts"]
    lines += [
        "",
        payload["paired"]["interpretation"],
        f"per-question wins on {wins['metric']}: "
        f"{treatment} {wins['wins'][treatment]}, "
        f"{baseline} {wins['wins'][baseline]}, ties {wins['ties']}",
        f"retrieval identical across arms: {payload['retrieval']['identical']}",
    ]

    for model, entry in sorted(payload["abstention"]["models"].items()):
        lines.append(
            f"abstention {model:<16} recall {number(entry['recall'], '.3f')}  "
            f"precision {number(entry['precision'], '.3f')}  "
            f"(abstained {entry['n_abstained']} of {entry['n_unanswerable']} unanswerable)"
        )

    for subset in payload["subsets"]:
        subset_wins = subset["win_counts"]
        lines.append(
            f"subset {subset['label']:<16} n = {subset['n_questions']:<3} "
            f"{treatment} {number(subset['means'][treatment]['mean'], '.3f')} vs "
            f"{baseline} {number(subset['means'][baseline]['mean'], '.3f')}  "
            f"(wins {subset_wins['wins'][treatment]}/{subset_wins['wins'][baseline]}, "
            f"ties {subset_wins['ties']}; descriptive only)"
        )

    return "\n".join(lines)
```

- [ ] **Step 2: Make key selection drive which rows are loaded**

Replace the body of `main` between the `--json` argument definition and the `if args.only:` block. The `--only` choices line becomes:

```python
    parser.add_argument(
        "--only",
        action="append",
        choices=list(phase1.ANALYSIS_KEYS) + list(phase2.ANALYSIS_KEYS),
        help="write only this analysis key (repeatable); all keys by default",
    )
```

And replace the load-and-build section (currently `cli.py:78-93`, from `try: rows = db.load_phase1_rows(dsn)` down to and including the `if args.only:` filter) with:

```python
    selected = set(args.only) if args.only else set(phase1.ANALYSIS_KEYS) | set(phase2.ANALYSIS_KEYS)
    payloads: dict[str, dict] = {}

    # Load only the rows the selection needs. Phase 1's build runs 14 permutation tests
    # and is the slow half, so `--only phase2_paired` should not pay for it — and an
    # incomplete phase should not block the analysis of a phase that is complete.
    if selected & set(phase1.ANALYSIS_KEYS):
        try:
            phase1_rows = db.load_phase1_rows(dsn)
        except Exception as exc:
            print(f"error: could not read Phase-1 rows: {exc}", file=sys.stderr)
            return 2
        print(f"loaded {len(phase1_rows)} Phase-1 rows")
        try:
            built = phase1.build_all(phase1_rows)
        except phase1.ShapeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        payloads.update({k: v for k, v in built.items() if k in selected})

    if selected & set(phase2.ANALYSIS_KEYS):
        try:
            phase2_rows = db.load_phase2_rows(dsn)
        except phase1.ShapeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"error: could not read Phase-2 rows: {exc}", file=sys.stderr)
            return 2
        print(f"loaded {len(phase2_rows)} Phase-2 rows")
        try:
            built = phase2.build_all(phase2_rows)
        except phase1.ShapeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        payloads.update({k: v for k, v in built.items() if k in selected})
```

Then, in the printing section, replace

```python
    else:
        print()
        print(_summarise(payloads))
```

with

```python
    else:
        print()
        summaries = [text for text in (_summarise(payloads),) if text]
        if "phase2_paired" in payloads:
            summaries.append(_summarise_phase2(payloads["phase2_paired"]))
        print("\n\n".join(summaries))
```

Finally, update the parser description from `"Phase-1 inferential statistics for tos-rag (PRD 11)."` to `"Phase-1 and Phase-2 inferential statistics for tos-rag (PRD 11)."`

`_summarise` already returns `""` when neither Phase-1 key is present, so the filter above drops it cleanly for a Phase-2-only run.

- [ ] **Step 3: Dry-run Phase 2 only, against the live database**

```bash
docker start supabase_db_tos-rag
cd analysis && uv run analyze --dry-run --only phase2_paired
```

Expected: no `loaded ... Phase-1 rows` line, `loaded 60 Phase-2 rows`, the Phase-2 table with `crag_score` means 0.9333 / 0.6000, per-question wins `claude-opus-4-8 5, llama3.1:8b 0, ties 25`, `retrieval identical across arms: True`, and `dry run — nothing written (phase2_paired)`.

- [ ] **Step 4: Dry-run everything**

Run: `cd analysis && uv run analyze --dry-run`
Expected: `loaded 300 Phase-1 rows`, `loaded 60 Phase-2 rows`, both summaries, `dry run — nothing written` listing all five keys.

- [ ] **Step 5: Confirm the Phase-1 output is unchanged**

```bash
cd analysis && uv run analyze --dry-run --json --only phase1_config_ranking phase1_best_vs_rest \
  > /tmp/claude-501/-Users-laxmilamichanne-Developer-college-tos-rag/scratchpad/phase1-after.json
```

Compare the winner and `n_significant` against the stored rows:

```bash
docker exec supabase_db_tos-rag psql -U postgres -d postgres -t -c \
  "select payload->>'winner' from analysis_results where analysis = 'phase1_config_ranking';" -c \
  "select payload->>'n_significant' from analysis_results where analysis = 'phase1_best_vs_rest';"
```

Expected: winner `sentence:512`, `n_significant` `0` — the same values the new run prints. This task refactors the CLI's control flow, so the Phase-1 result must be proven untouched rather than assumed.

- [ ] **Step 6: Run the Python suite**

Run: `cd analysis && uv run pytest -q`
Expected: PASS.

- [ ] **Step 7: Stage, do not commit**

```bash
git add analysis/src/tosrag_analysis/cli.py
# Do not commit yet — see Global Constraints. Proposed message:
# feat(analysis): add phase2_paired to analyze, loading only the rows a key needs
```

---

### Task 7: Write the row, verify acceptance, update the docs

**Files:**
- Modify: `CLAUDE.md` — the "The analysis path (Python)" section
- Modify: `docs/report-notes.md` — append a session entry

- [ ] **Step 1: Write `phase2_paired` for real**

```bash
docker start supabase_db_tos-rag
cd analysis && uv run analyze
```

Expected: both summaries, then `wrote analysis_results:` listing six keys — `judge_validation`, the four `phase1_*`, and `phase2_paired`.

- [ ] **Step 2: Verify idempotence and byte-identity (spec §11 acceptance 6)**

```bash
cd analysis
uv run analyze --dry-run --json --only phase2_paired > /tmp/claude-501/-Users-laxmilamichanne-Developer-college-tos-rag/scratchpad/p2-a.json
uv run analyze --dry-run --json --only phase2_paired > /tmp/claude-501/-Users-laxmilamichanne-Developer-college-tos-rag/scratchpad/p2-b.json
diff /tmp/claude-501/-Users-laxmilamichanne-Developer-college-tos-rag/scratchpad/p2-a.json \
     /tmp/claude-501/-Users-laxmilamichanne-Developer-college-tos-rag/scratchpad/p2-b.json && echo "BYTE-IDENTICAL"
```

Expected: `BYTE-IDENTICAL`. If it differs, the payload has an unseeded or wall-clock-dependent value and must be fixed before continuing — reproducibility is a claim the report makes.

Then re-run the write and confirm exactly one row per key:

```bash
cd analysis && uv run analyze > /dev/null
docker exec supabase_db_tos-rag psql -U postgres -d postgres -c \
  "select analysis, count(*) from analysis_results group by analysis order by analysis;"
```

Expected: six rows, each with `count = 1`.

- [ ] **Step 3: Verify the stored payload against the database directly**

```bash
docker exec supabase_db_tos-rag psql -U postgres -d postgres -c "
select
  payload->'arms'->'claude-opus-4-8'->'metrics'->'crag_score'->>'mean' as opus_crag,
  payload->'arms'->'llama3.1:8b'->'metrics'->'crag_score'->>'mean' as llama_crag,
  payload->'win_counts'->'wins'->>'claude-opus-4-8' as opus_wins,
  payload->'win_counts'->>'ties' as ties,
  payload->'retrieval'->>'identical' as retrieval_identical,
  payload->'paired'->>'n_significant' as n_significant
from analysis_results where analysis = 'phase2_paired';"
```

Expected: `opus_crag` 0.9333…, `llama_crag` 0.6, `opus_wins` 5, `ties` 25, `retrieval_identical` true. Record whatever `n_significant` is — do not assume it; with 5 wins, 0 losses and 25 ties the raw p is near the floor a sign pattern that sparse can reach, and Holm across 5 metrics may or may not clear 0.05. **Whatever it is, that is the Chapter 6 result.**

- [ ] **Step 4: Confirm nothing but `analysis_results` changed (spec §11 acceptance 5)**

```bash
docker exec supabase_db_tos-rag psql -U postgres -d postgres -c "
select count(*) as runs from runs;" -c "
select count(*) as evals,
       count(crag_score) as crag,
       count(faithfulness) as faith,
       count(cosine_sim) as cosine,
       count(cost_usd) as cost
from evals;"
```

Expected: `runs` 360; `evals` 360, `crag` 360, `faith` 291, `cosine` 360, `cost` 60 — unchanged from before this work.

- [ ] **Step 5: Run the full gate**

```bash
cd analysis && uv run pytest -q
cd .. && pnpm test && pnpm typecheck
```

Expected: all green. `pnpm test`/`pnpm typecheck` cover no changed TypeScript here, so they should pass untouched — run them anyway, because the acceptance criteria name them.

- [ ] **Step 6: Update `CLAUDE.md`**

In the "The analysis path (Python)" section, extend the sentence describing the pure/impure split so it names `phase2.py`:

> It repeats the repo's core split: `stats.py` (pure primitives: Wilcoxon, BCa bootstrap, Holm), `phase1.py` and `phase2.py` (pure payload builders — rows in, payloads out) hold everything that must be *correct* and are testable with fixtures alone; `db.py` is the only module that touches Postgres.

And add these bullets to the "Things that bite" list:

> - **`phase2.py` pairs by question and never coerces a NULL.** A NULL `faithfulness` is expected (abstentions) and is handled by pairwise deletion with the dropped question ids reported; a NULL `crag_score` raises, because 0 is a real score. The two NULL reasons are different findings and the payload keeps them apart.
> - **Retrieval metrics are reported but never tested.** Both Phase-2 arms share one frozen config, k, embedder and query, so `char_precision`/`char_recall`/`hit_at_8` are identical per question; testing them would add degenerate comparisons that inflate the Holm correction the real metrics pay. `build_retrieval_identity` measures that identity rather than assuming it, because "the difference is generation-only" is Chapter 6's load-bearing claim.
> - **Abstention is detected from the answer text, never from `judge_explanation`.** Since the PRD §15 #12 amendment `cragScore` checks exact match first, so `judge_explanation = 'abstained'` is 0 on all 360 rows. `is_abstention` in `phase2.py` is a cross-language copy of `isAbstention` in `packages/core/src/prompts.ts` and must stay in sync with it. It matches only the exact phrase, so §10.4 recall is a lower bound and the payload says so.

- [ ] **Step 7: Append the session entry to `docs/report-notes.md`**

Add a `## Session 2026-08-05 — Phase-2 paired statistics` section covering, with the real numbers from Step 3:

- What was built and where (`phase2.py`, the `phase2_paired` key, the CLI becoming selective).
- The headline: Opus 0.9333 vs Llama 0.6000, paired 5/0/25, and the Holm-corrected verdict — stated as whatever it computed to, with the ties count as the explanation, mirroring the Phase-1 write-up.
- **The metrics that disagree**: Llama ahead on `squad_f1` (0.5964 vs 0.5685) and `squad_em` (0.1333 vs 0.1000). This is terseness being rewarded by token-overlap metrics, and it belongs in §6.2 as evidence that the headline is metric-dependent, not as an inconvenience.
- Retrieval identity confirmed empirically: 0 of 30 questions differ on any retrieval metric, so §6.5's claim is measured rather than argued.
- Abstention P/R per arm, with the `missed_question_ids` list and the lower-bound caveat.
- The held-out/reused split, marked descriptive-only, and the fact that **the held-out 10 contain no unanswerable questions**, so abstention recall is undefined there.
- Cost: Opus $0.6719 total, Llama $0, and that $0 means "no marginal API cost".
- What is now unblocked: report §6.7, and §6.6 if any cost detail was still open.

- [ ] **Step 8: Stage, do not commit**

```bash
git add CLAUDE.md docs/report-notes.md
# Do not commit yet — see Global Constraints. Proposed message:
# docs: record the Phase-2 paired statistics run
```

- [ ] **Step 9: Report to the user and ask before committing**

Summarise: the payload sections written, the headline numbers, the Holm verdict, and the `squad_*` disagreement. Then ask whether to create issue #27, branch `feature/27`, commit the staged work, and open the PR — none of which happens without an explicit yes.

---

## Acceptance (from the spec, §11)

Only the items this plan is responsible for. Items 2–5 were satisfied by the already-merged backfill (#25/#26) and are re-verified in Task 7 Step 4 as a regression check.

| # | Criterion | Verified by |
|---|---|---|
| 1 | `pnpm test`, `pnpm typecheck`, and `uv run pytest` pass | Task 7 Step 5 |
| 5 | `runs` and `evals` unchanged | Task 7 Step 4 |
| 6 | `pnpm analyze` writes a `phase2_paired` row containing every §5.5 payload item; re-running is idempotent and byte-identical | Task 4 Step 4 (payload sections), Task 7 Steps 1–2 |
| 7 | Every number Chapter 6 quotes is readable from `analysis_results` or `evals` | Task 7 Step 3 |

**§5.5 payload checklist** — every item must appear in `phase2_paired`:

- [x] Per model, per metric: mean + BCa 95% CI, `n_used` carried per entry → `arms.<model>.metrics`
- [x] Paired Wilcoxon per metric, Monte Carlo permutation at n = 30, `zero_method='zsplit'` → `paired.metrics[].wilcoxon`
- [x] Holm correction across the metric family → `paired.metrics[].p_holm`, `paired.family`
- [x] Per-question win counts → `win_counts`
- [x] Latency median + p95 split by `retrieval_ms`/`generation_ms`, per model → `arms.<model>.latency_ms`
- [x] Cost total and per-run USD per model, plus total tokens → `arms.<model>.cost`
- [x] Abstention precision/recall per model → `abstention.models`
- [x] Held-out subset reported separately, descriptive only, saying so in the payload → `subsets[0]`

## Out of Scope

Carried from spec §10 plus this session's scope decision:

- **Phase-1 abstention precision/recall** (report §5.9). Decided 2026-08-05: Phase 2 only. The machinery in `build_abstention` is phase-agnostic and will be reusable when §5.9 is picked up.
- Wiring the dashboard to `/api/results`; `DashboardView` still renders `SAMPLE_PHASE1`.
- Writing report §6.7 prose — this produces the numbers it needs.
- The `60/30` completeness-line bug in `run-phase2.ts`.
- Re-running either phase, or recomputing any `evals` column.
- Every frozen constant.

## Self-Review

**Spec coverage.** §5.5 is covered item by item in the checklist above. §5.5's "the query asserts a single config id is present" is Task 5 Step 2. §5.5's `assert_phase2_shape` requirement ("exactly 2 models × 30 questions, every question present in both arms") is Task 1. The spec's §2 scope row for Phase-1 abstention is deliberately deferred per the 2026-08-05 scope decision, recorded under Out of Scope rather than dropped silently.

**Placeholders.** None: every code step carries the actual code, every verification step carries the actual command and its expected output. The one place an expected value is *not* pinned is Task 7 Step 3's `n_significant`, and that is deliberate — predicting it would invite implementing toward a guess.

**Type consistency.** `Phase2Row` field names match the `PHASE2_QUERY` column names and the `db.py` constructor call. `PairedMetric.a`/`.b` are treatment/baseline in every consumer. `TESTED_METRICS` keys match `METRIC_NOTES` keys exactly (`crag_score`, `faithfulness`, `cosine_sim`, `squad_f1`, `squad_em`); `RETRIEVAL_METRICS` keys match `RETRIEVAL_METRIC_NOTES` exactly. `ShapeError` is imported into `phase2.py` from `phase1.py` and re-exported, so `cli.py`'s single `except phase1.ShapeError` catches both phases' shape failures — and `db.load_phase2_rows` raises that same type, which is why Task 6 Step 2 catches it before the generic `Exception`. `build_win_counts` returns `wins` keyed by model id, and both `_summarise_phase2` and the subset tests read it that way.
