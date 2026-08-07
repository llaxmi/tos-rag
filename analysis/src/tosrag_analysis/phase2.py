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
from .stats import summarise_latency as _summarise_latency

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
    "comparison, not query-vs-document. Phase 1's own analysis found Spearman rho "
    "(cosine_sim, crag_score) = -0.001 across the 15 configurations -- no monotonic "
    "relationship to answer quality -- so it is reportable here as a descriptive "
    "statistic and not as a proxy for the judge.",
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

_SMART_QUOTES = str.maketrans({'’': "'", '‘': "'"})


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


def _permutation_floor(discordant: int) -> float:
    """Smallest attainable two-sided sign-flip permutation p at this discordant count.

    A sign-flip permutation is invariant under flipping a zero difference: the sign of a
    tie never changes the statistic, so the whole permutation distribution collapses
    onto the `discordant` non-zero pairs regardless of how many ties sit alongside them.
    With `discordant` non-zero pairs there are only 2**discordant equally likely sign
    patterns, and a two-sided test can call significant only the most extreme one on
    each side -- hence the floor of 2/2**discordant, independent of both the tie count
    and the effect size.
    """
    return min(2 / (2**discordant), 1.0)


def _min_discordant_for_alpha(alpha: float) -> int:
    """Smallest discordant count whose permutation floor no longer exceeds alpha."""
    discordant = 0
    while _permutation_floor(discordant) > alpha:
        discordant += 1
    return discordant


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _floor_note(discordant: int, ties: int, alpha: float) -> str:
    """State the permutation floor for this metric's own discordant-pair count.

    The general formula 2/2**discordant breaks down at discordant = 0: its literal
    value is 2, which is not a probability, and the reason is not "the floor is capped
    at 1" -- a sign-flip permutation with zero non-tied pairs has exactly one possible
    arrangement (the one observed), so there is nothing more extreme for a two-sided
    test to call significant and the attainable p never drops below 1. That case is
    stated directly below instead of quoting the (here meaningless) fraction, so the
    note never asserts the false equation 2/2**0 = 1. For discordant >= 1 the formula
    is already a valid probability on its own and is unchanged.
    """
    if discordant == 0:
        needed = _min_discordant_for_alpha(alpha)
        return (
            f"{_plural(discordant, 'discordant pair')} ({_plural(ties, 'tie')}): with "
            "no discordant pairs there is no evidence of a difference at all, so the "
            f"permutation test cannot attain a two-sided p below 1, above alpha = {alpha}: "
            "no effect size could reach significance at this discordance count. "
            f"{needed} discordant pairs would be needed."
        )
    floor = _permutation_floor(discordant)
    base = (
        f"{_plural(discordant, 'discordant pair')} ({_plural(ties, 'tie')}) bound the "
        f"two-sided p at 2/2**{discordant} = {floor:g}"
    )
    if floor > alpha:
        needed = _min_discordant_for_alpha(alpha)
        return (
            f"{base}, above alpha = {alpha}: no effect size could reach significance "
            f"at this discordance count. {needed} discordant pairs would be needed."
        )
    return f"{base}, at or below alpha = {alpha}."


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
            discordant = result.wins + result.losses
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
                    "floor_note": _floor_note(discordant, result.ties, alpha),
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
            f"{len(tested)} tested metrics after Holm correction at alpha = {alpha}, "
            "though for any metric whose permutation floor (see floor_note) already "
            "exceeds alpha, Holm correction was not the binding constraint."
        ),
        "floor_note_explanation": (
            "the tie count does not affect the floor because a sign-flip permutation is "
            "invariant under flipping a zero difference, so only the discordant-pair "
            "count sets the smallest attainable two-sided p"
        ),
        "metrics": entries,
    }


def _sum_int(rows: Iterable[Phase2Row], field: str) -> int | None:
    present = [getattr(r, field) for r in rows if getattr(r, field) is not None]
    return int(sum(present)) if present else None


def build_arm_summary(rows: Sequence[Phase2Row]) -> dict:
    """Per model: metric estimates, latency by stage, cost and tokens.

    Latency is a five-number summary (min/q1/median/q3/max) + p95 per PRD 10.5 rather
    than a mean, because a single slow generation dominates a mean at n = 30 and the
    report needs the typical case, the spread, and the tail stated separately — the
    quartiles feed the dashboard's box plot.
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
                stage: _summarise_latency(_values(model_rows, stage))
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
            # Computed from the treatment arm's values only. Equals the shared value
            # exactly when `identical` is True above; if the arms diverge, this is one
            # arm's estimate, not a shared one. Nothing consumes this key yet.
            "treatment_estimate": estimate(
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
