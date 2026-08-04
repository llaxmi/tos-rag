"""Judge validation — pure sampling and agreement statistics (PRD 10.3, 6).

Rows in, sample out; labels in, kappa out. No database and no file I/O live here, so
the part that must be *correct* is testable with fixtures alone — the same split
`stats.py`/`db.py` already makes.

The gate this serves: every Truthfulness number in the report rests on the Sonnet judge
being trustworthy, and that premise is unvalidated until a human sample agrees with it
at Cohen's kappa >= 0.61.
"""

from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

from .stats import BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, CI

SAMPLE_SEED = 42

#: The gate from PRD 10.3 — Landis & Koch "substantial" agreement.
KAPPA_GATE = 0.61

#: The judge's decision space once the deterministic rules have run: it emits only
#: +1 or -1, so human labels are forced to the same binary choice. Offering a third
#: option would make the two label sets incomparable.
ACCURATE = "accurate"
INCORRECT = "incorrect"
LABELS = (ACCURATE, INCORRECT)

#: Tolerated spellings of each label. Annotators type into a spreadsheet, and a typo
#: that silently became a valid label would corrupt the statistic it feeds.
_ALIASES: dict[str, str] = {
    "accurate": ACCURATE,
    "correct": ACCURATE,
    "right": ACCURATE,
    "a": ACCURATE,
    "y": ACCURATE,
    "yes": ACCURATE,
    "1": ACCURATE,
    "+1": ACCURATE,
    "incorrect": INCORRECT,
    "wrong": INCORRECT,
    "i": INCORRECT,
    "n": INCORRECT,
    "no": INCORRECT,
    "-1": INCORRECT,
}

class JudgeValidationError(ValueError):
    """Raised for a malformed label file or an impossible sample request."""


@dataclass(frozen=True)
class JudgedRow:
    """One run whose CRAG score came from the judge rather than a deterministic rule."""

    run_id: int
    phase: int
    model: str
    config: str
    question_id: str
    qtype: str
    question: str
    expected_answer: str
    answer: str
    judge_score: int
    judge_explanation: str

    @property
    def judge_label(self) -> str:
        return ACCURATE if self.judge_score > 0 else INCORRECT


def normalise_label(raw: str, *, where: str) -> str:
    """One annotator cell -> a canonical label, or a named error."""
    key = raw.strip().lower()
    if not key:
        raise JudgeValidationError(f"{where}: label is blank — every sampled row must be labelled")
    if key not in _ALIASES:
        raise JudgeValidationError(
            f"{where}: {raw!r} is not a label. Use {ACCURATE!r} or {INCORRECT!r} "
            f"(or right/wrong, y/n)."
        )
    return _ALIASES[key]


def draw_sample(
    rows: Sequence[JudgedRow], n: int = 50, seed: int = SAMPLE_SEED
) -> list[JudgedRow]:
    """A verdict-balanced, type-spread, deterministic sample of judged rows.

    **Balanced, not proportional.** ~83% of judged rows are +1, so a proportional draw
    would be almost entirely accurates and would say nothing about whether the judge
    catches a wrong answer. Cohen's kappa also collapses toward 0 under skewed marginals
    even at high agreement, so a proportional sample could fail the gate through
    sampling design rather than judge quality. The cost is that kappa here estimates
    agreement on a balanced sample, not on the population — the report must say so.

    Within each verdict half, rows are taken round-robin across question types so no
    single type dominates, degrading gracefully when a type runs out.
    """
    if n <= 0:
        raise JudgeValidationError("sample size must be positive")

    halves: dict[str, list[JudgedRow]] = {label: [] for label in LABELS}
    for row in rows:
        halves[row.judge_label].append(row)

    per_half = n // 2
    for label, available in halves.items():
        if len(available) < per_half:
            raise JudgeValidationError(
                f"only {len(available)} rows judged {label!r}, need {per_half} for a "
                f"balanced sample of {n} — lower --n"
            )

    picked: list[JudgedRow] = []
    for label in LABELS:
        picked.extend(_round_robin_by_qtype(halves[label], per_half, seed))
    # Sort by run_id so the emitted sheet has no ordering signal: a reader must not be
    # able to infer the verdict from an accurates-then-incorrects block.
    return sorted(picked, key=lambda r: r.run_id)


def _round_robin_by_qtype(
    rows: Sequence[JudgedRow], count: int, seed: int
) -> list[JudgedRow]:
    buckets: dict[str, list[JudgedRow]] = {}
    for row in sorted(rows, key=lambda r: r.run_id):  # deterministic before shuffling
        buckets.setdefault(row.qtype, []).append(row)

    rng = random.Random(seed)
    for bucket in buckets.values():
        rng.shuffle(bucket)

    picked: list[JudgedRow] = []
    order = sorted(buckets)
    while len(picked) < count:
        progressed = False
        for qtype in order:
            if len(picked) == count:
                break
            if buckets[qtype]:
                picked.append(buckets[qtype].pop())
                progressed = True
        if not progressed:  # pragma: no cover — guarded by the caller's count check
            break
    return picked


def agreement_rate(a: Sequence[str], b: Sequence[str]) -> float:
    """Raw percentage agreement — reported alongside kappa, never instead of it."""
    _require_paired(a, b)
    return float(np.mean([x == y for x, y in zip(a, b)]))


def cohens_kappa(a: Sequence[str], b: Sequence[str]) -> float | None:
    """Cohen's kappa = (po - pe) / (1 - pe), or None when it is undefined.

    kappa is undefined when pe == 1 — both raters used a single label for every row.
    That is a real outcome for a small balanced sample, and returning None keeps it
    visible rather than dividing by zero or reporting a fabricated 0.0.
    """
    _require_paired(a, b)
    n = len(a)
    observed = agreement_rate(a, b)
    expected = sum(
        (sum(1 for x in a if x == label) / n) * (sum(1 for y in b if y == label) / n)
        for label in LABELS
    )
    if abs(1.0 - expected) < 1e-12:
        return None
    return float((observed - expected) / (1.0 - expected))


def kappa_band(kappa: float | None) -> str:
    """The Landis & Koch (1977) descriptor for a kappa value (band upper bounds)."""
    if kappa is None:
        return "undefined"
    if kappa <= 0.00:
        return "poor"
    if kappa <= 0.20:
        return "slight"
    if kappa <= 0.40:
        return "fair"
    if kappa <= 0.60:
        return "moderate"
    if kappa <= 0.80:
        return "substantial"
    return "almost perfect"


def _binary_kappa(a: np.ndarray, b: np.ndarray) -> float | None:
    """Cohen's kappa for 0/1-encoded labels — bit-for-bit identical to `cohens_kappa`
    for this module's binary `LABELS`, computed with array ops instead of Python-level
    loops so `kappa_ci`'s resampling loop (10,000 iterations by default) stays cheap.

    Mirrors `cohens_kappa`'s summation order exactly (label 1's term, then label 0's):
    deriving `p_a0`/`p_b0` as `1 - p_a1` instead would be algebraically equivalent but
    not bit-identical, and this project's bootstrap results are pinned to a seed on the
    understanding that they are exactly reproducible.
    """
    n = a.size
    a1, b1 = int(np.count_nonzero(a)), int(np.count_nonzero(b))
    observed = float(np.mean(a == b))
    expected = (a1 / n) * (b1 / n) + ((n - a1) / n) * ((n - b1) / n)
    if abs(1.0 - expected) < 1e-12:
        return None
    return (observed - expected) / (1.0 - expected)


def kappa_ci(
    a: Sequence[str],
    b: Sequence[str],
    *,
    resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int = BOOTSTRAP_SEED,
) -> CI | None:
    """Seeded percentile bootstrap interval for kappa, resampling annotated rows.

    Reported because a bare kappa from ~50 rows is a wide estimate presented as a point,
    and this project does not present bare point estimates (PRD 11).
    """
    _require_paired(a, b)
    n = len(a)
    if n < 2:
        return None
    # 0/1-encoded once, outside the loop, and resampled via `_binary_kappa` rather than
    # rebuilding two Python lists and calling `cohens_kappa`'s generator-based formula
    # on every one of `resamples` iterations.
    a_bin = np.array([1 if label == ACCURATE else 0 for label in a])
    b_bin = np.array([1 if label == ACCURATE else 0 for label in b])
    rng = np.random.default_rng(seed)
    values: list[float] = []
    for _ in range(resamples):
        idx = rng.integers(0, n, size=n)
        k = _binary_kappa(a_bin[idx], b_bin[idx])
        if k is not None:
            values.append(k)
    if len(values) < resamples // 2:
        return None
    low, high = np.percentile(values, [2.5, 97.5])
    return CI(low=float(low), high=float(high))


def _require_paired(a: Sequence[str], b: Sequence[str]) -> None:
    if len(a) != len(b):
        raise JudgeValidationError(f"label sets differ in length: {len(a)} vs {len(b)}")
    if not a:
        raise JudgeValidationError("no labels to compare")


def _agreement_block(a: Sequence[str], b: Sequence[str]) -> dict:
    kappa = cohens_kappa(a, b)
    ci = kappa_ci(a, b)
    return {
        "n": len(a),
        "percent_agreement": agreement_rate(a, b),
        "kappa": kappa,
        "kappa_ci": ci.as_dict() if ci else None,
        "band": kappa_band(kappa),
    }


def build_validation_payload(
    rows: Sequence[JudgedRow],
    labels_a: Sequence[str],
    labels_b: Sequence[str],
    final_labels: Sequence[str],
) -> dict:
    """The `judge_validation` payload: both kappas, the gate verdict, and the caveats.

    Two kappas, because the proposal asks for two different things: annotator-vs-annotator
    on the first pass (is the ground-truth process reliable?) and judge-vs-adjudicated
    (is the judge trustworthy?). Only the second is gated at 0.61.
    """
    inter = _agreement_block(labels_a, labels_b)
    judge_labels = [row.judge_label for row in rows]
    versus_judge = _agreement_block(judge_labels, final_labels)

    kappa = versus_judge["kappa"]
    passes = kappa is not None and kappa >= KAPPA_GATE

    return {
        "sample": {
            "n": len(rows),
            "stratification": "balanced by judge verdict, round-robin across qtype",
            "by_qtype": _counts(row.qtype for row in rows),
            "by_judge_label": _counts(judge_labels),
            "by_phase": _counts(str(row.phase) for row in rows),
        },
        "inter_annotator": inter,
        "judge_vs_human": versus_judge,
        "gate": {
            "threshold": KAPPA_GATE,
            "passes": passes,
            "interpretation": _interpret(kappa, passes),
        },
        "caveats": [
            "Sample is balanced by judge verdict, so kappa describes agreement on the "
            "balanced sample and not on the full judged population (~83% accurate).",
            "Only rows the judge decided are validated; rows settled by the "
            "deterministic rules (abstention, exact match) need no human check.",
        ],
    }


def _counts(values: Iterable[str]) -> dict[str, int]:
    return dict(sorted(Counter(values).items()))


def _interpret(kappa: float | None, passes: bool) -> str:
    if kappa is None:
        return (
            "kappa is undefined — every row carries the same label, so there is no "
            "agreement beyond chance to measure. Re-draw a larger sample."
        )
    if passes:
        return (
            f"kappa = {kappa:.3f} meets the >= {KAPPA_GATE} gate ({kappa_band(kappa)} "
            "agreement): the judge's scores can be reported as trustworthy."
        )
    return (
        f"kappa = {kappa:.3f} is below the >= {KAPPA_GATE} gate ({kappa_band(kappa)} "
        "agreement). PRD 10.3 requires iterating the judge prompt and re-judging before "
        "the Truthfulness numbers are trusted."
    )
