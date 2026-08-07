"""Phase-1 analyses — pure composition: rows in, payloads out.

No database access lives here, so every payload is reproducible from a fixture frame.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

import numpy as np

from .grid import ShapeError, assert_complete_grid, group_by
from .grid import mean_or_none as _mean_or_none
from .grid import values as _values
from .stats import Estimate, clean_values, estimate, holm, paired_wilcoxon, summarise_latency

# Re-exported: ShapeError is raised from `grid`, but callers (cli.py, tests) have
# always caught it off the phase module.
__all__ = ["ShapeError"]

EXPECTED_CONFIGS = 15  # 5 strategies x 3 chunk sizes
EXPECTED_QUESTIONS = 20  # Round-1 questions (PRD 7)

# The headline metric. Truthfulness = mean CRAG score in {-1, 0, +1}
# = accuracy_rate - hallucination_rate (PRD 10.3).
HEADLINE_METRIC = "crag_score"

METRIC_NOTES: dict[str, str] = {
    "crag_score": "Truthfulness: mean CRAG judge score in {-1,0,+1} (PRD 10.3). Headline metric.",
    "char_precision": "Char-span precision; NULL for unanswerable questions (PRD 10.1). "
    "Intrinsically low: chunks are far larger than gold spans.",
    "char_recall": "Char-span recall; NULL for unanswerable questions (PRD 10.1).",
    "hit_at_8": "Hit rate at k=5. Column name is legacy (k was reduced from 8; PRD 15 #11).",
    "squad_f1": "SQuAD token-overlap F1. Low across the board because Llama answers tersely.",
    "squad_em": "SQuAD exact match.",
    "faithfulness": "Answer-vs-context faithfulness; NULL for abstentions and for answers "
    "that decompose to zero statements. Descriptive only — not part of the tested family.",
    "retrieval_ms": "Retrieval latency, milliseconds. Lower is better.",
    "generation_ms": "Generation latency, milliseconds. Lower is better.",
}


@dataclass(frozen=True)
class Row:
    """One (config, question) observation: a `runs` row joined to its `evals` row."""

    strategy: str
    chunk_size: int
    question_id: str
    qtype: str
    crag_score: float | None = None
    char_precision: float | None = None
    char_recall: float | None = None
    hit_at_8: float | None = None
    squad_f1: float | None = None
    squad_em: float | None = None
    faithfulness: float | None = None
    retrieval_ms: float | None = None
    generation_ms: float | None = None

    @property
    def config(self) -> str:
        return f"{self.strategy}:{self.chunk_size}"

    def metric(self, name: str) -> float | None:
        return getattr(self, name)


def assert_phase1_shape(
    rows: Sequence[Row],
    expected_configs: int = EXPECTED_CONFIGS,
    expected_questions: int = EXPECTED_QUESTIONS,
) -> None:
    """Assert the loaded rows are a complete 15-config x 20-question grid."""
    assert_complete_grid(
        rows,
        key=lambda r: r.config,
        noun="config",
        noun_plural="configs",
        expected_groups=expected_configs,
        expected_questions=expected_questions,
        phase_label="Phase-1",
        run_command="run-phase1",
    )


def _by_config(rows: Sequence[Row]) -> dict[str, list[Row]]:
    return group_by(rows, lambda r: r.config)


def rank_configs(rows: Sequence[Row]) -> list[str]:
    """Apply the PRD winner-selection rule, highest first.

    Best mean Truthfulness; ties broken by char-recall, then by lower generation latency.
    Computed rather than hardcoded, so if the data ever disagrees with the expected
    winner the analysis reports the disagreement instead of assuming it away.
    """
    grouped = _by_config(rows)

    def sort_key(config: str):
        rs = grouped[config]
        truthfulness = _mean_or_none(_values(rs, HEADLINE_METRIC))
        recall = _mean_or_none(_values(rs, "char_recall"))
        latency = _mean_or_none(_values(rs, "generation_ms"))
        return (
            -(truthfulness if truthfulness is not None else float("-inf")),
            -(recall if recall is not None else float("-inf")),
            latency if latency is not None else float("inf"),
            config,  # final tie-break keeps the ordering deterministic
        )

    return sorted(grouped, key=sort_key)


def build_config_ranking(rows: Sequence[Row]) -> dict:
    """Per config: n and mean + BCa CI for every metric."""
    grouped = _by_config(rows)
    order = rank_configs(rows)

    entries = []
    for rank, config in enumerate(order, start=1):
        config_rows = grouped[config]
        entries.append(
            {
                "rank": rank,
                "config": config,
                "strategy": config_rows[0].strategy,
                "chunk_size": config_rows[0].chunk_size,
                "metrics": {
                    metric: estimate(_values(config_rows, metric)).as_dict()
                    for metric in METRIC_NOTES
                },
                # Sibling to the mean+CI estimates above: a five-number summary per
                # stage, for the dashboard's per-config latency box plot (PRD 10.5).
                "latency_ms": {
                    stage: summarise_latency(_values(config_rows, stage))
                    for stage in ("retrieval_ms", "generation_ms")
                },
            }
        )

    return {
        "headline_metric": HEADLINE_METRIC,
        "metric_notes": METRIC_NOTES,
        "selection_rule": "max mean Truthfulness; ties -> higher char_recall -> lower generation_ms",
        "winner": order[0],
        "n_configs": len(order),
        "configs": entries,
    }


def build_factor_analysis(rows: Sequence[Row], factor: str) -> dict:
    """Factor isolation (PRD 11): per-question Truthfulness averaged across the other factor.

    Averaging per question first keeps one value per question per level, which is what
    makes the bootstrap resample the right unit — questions, not (config, question) cells.
    """
    if factor not in ("strategy", "chunk_size"):
        raise ValueError(f"factor must be 'strategy' or 'chunk_size', got {factor!r}")

    levels = sorted({getattr(r, factor) for r in rows}, key=str)
    question_ids = sorted({r.question_id for r in rows})

    entries = []
    for level in levels:
        level_rows = [r for r in rows if getattr(r, factor) == level]
        # Bucket once by question rather than re-filtering `level_rows` per question:
        # the nested scan is 5 x 20 x 60 row visits per factor where this is 300.
        by_question = group_by(level_rows, lambda r: r.question_id)
        per_question = [
            _mean_or_none(_values(by_question.get(qid, []), HEADLINE_METRIC))
            for qid in question_ids
        ]
        est: Estimate = estimate(per_question)
        entries.append(
            {
                "level": level,
                "n_configs_averaged": len({r.config for r in level_rows}),
                "estimate": est.as_dict(),
            }
        )

    entries.sort(key=lambda e: (e["estimate"]["mean"] is None, -(e["estimate"]["mean"] or 0.0)))
    return {
        "factor": factor,
        "metric": HEADLINE_METRIC,
        "unit_of_analysis": "per-question mean across the other factor's levels",
        "n_questions": len(question_ids),
        "levels": entries,
    }


def build_best_vs_rest(rows: Sequence[Row], alpha: float = 0.05) -> dict:
    """Winner vs each other config: paired Wilcoxon on Truthfulness, Holm-corrected.

    Holm is applied across these 14 comparisons only (PRD 11). Testing every metric
    would multiply the correction burden with nothing reportable gained.
    """
    grouped = _by_config(rows)
    order = rank_configs(rows)
    winner = order[0]
    question_ids = sorted({r.question_id for r in rows})

    def vector(config: str) -> list[float]:
        lookup = {r.question_id: r.metric(HEADLINE_METRIC) for r in grouped[config]}
        missing = [qid for qid in question_ids if lookup.get(qid) is None]
        if missing:
            # Never coerce a NULL to 0.0 here: 0 is a real CRAG score (Missing/abstention),
            # so the substitution would read as an abstention that never happened.
            raise ShapeError(
                f"config {config} has no {HEADLINE_METRIC} for {missing} — "
                "the paired test needs a complete pair for every question"
            )
        return [float(lookup[qid]) for qid in question_ids]

    winner_vector = vector(winner)

    comparisons = []
    for config in order[1:]:
        other_vector = vector(config)
        result = paired_wilcoxon(winner_vector, other_vector)
        differences = [w - o for w, o in zip(winner_vector, other_vector)]
        comparisons.append(
            {
                "config": config,
                "winner_mean": float(np.mean(winner_vector)),
                "other_mean": float(np.mean(other_vector)),
                "median_difference": float(np.median(differences)),
                "mean_difference": estimate(differences).as_dict(),
                "wilcoxon": result.as_dict(),
                "p_raw": result.p_value,
            }
        )

    adjusted = holm([c["p_raw"] for c in comparisons])
    for comparison, p_holm in zip(comparisons, adjusted):
        comparison["p_holm"] = p_holm
        comparison["significant"] = p_holm < alpha

    n_significant = sum(1 for c in comparisons if c["significant"])
    return {
        "winner": winner,
        "metric": HEADLINE_METRIC,
        "test": "paired Wilcoxon signed-rank, two-sided, zero_method=zsplit",
        "correction": "holm",
        "alpha": alpha,
        "n_comparisons": len(comparisons),
        "n_significant": n_significant,
        "interpretation": (
            f"{winner} is separable from {n_significant} of {len(comparisons)} other configs "
            f"after Holm correction at alpha = {alpha}."
        ),
        "comparisons": comparisons,
    }


# The single registry of Phase-1 analyses: `build_all`'s output and the CLI's
# `--only` choices are both derived from it, so an added or renamed analysis
# cannot silently exist in one and not the other.
_BUILDERS: dict[str, Callable[[Sequence[Row]], dict]] = {
    "phase1_config_ranking": build_config_ranking,
    "phase1_factor_strategy": lambda rows: build_factor_analysis(rows, "strategy"),
    "phase1_factor_size": lambda rows: build_factor_analysis(rows, "chunk_size"),
    "phase1_best_vs_rest": build_best_vs_rest,
}

ANALYSIS_KEYS: tuple[str, ...] = tuple(_BUILDERS)


def build_all(
    rows: Sequence[Row],
    expected_configs: int = EXPECTED_CONFIGS,
    expected_questions: int = EXPECTED_QUESTIONS,
) -> dict[str, dict]:
    """Every Phase-1 analysis, keyed by its `analysis_results.analysis` value.

    The expected grid is a parameter because Phase 2 runs the full 30-question set
    against a single config; the Phase-1 defaults are the frozen 15 x 20.
    """
    assert_phase1_shape(rows, expected_configs, expected_questions)
    return {key: build(rows) for key, build in _BUILDERS.items()}
