"""Pure statistical primitives — no database, no I/O, no global state.

The part of the analysis that must be *correct* is kept free of side effects so it can
be tested with fixtures alone, the same split `plan-ingest.ts` makes on the ingestion
path. Every function here is deterministic: given the same inputs it returns the same
output, which is what lets the report claim reproducibility.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np
from scipy import stats as sps
from statsmodels.stats.multitest import multipletests

BOOTSTRAP_SEED = 42
BOOTSTRAP_RESAMPLES = 10_000

# Above this many pairs, enumerating all 2**n sign flips stops being cheap and the
# permutation test switches to seeded Monte Carlo. 2**20 = ~1.05M is comfortable;
# Phase 1 (n = 20) is therefore exhaustive, as PRD 11 specifies.
EXHAUSTIVE_MAX_PAIRS = 20
MONTE_CARLO_RESAMPLES = 99_999


@dataclass(frozen=True)
class CI:
    """A 95% confidence interval."""

    low: float
    high: float

    def as_dict(self) -> dict[str, float]:
        return {"low": self.low, "high": self.high}


@dataclass(frozen=True)
class Estimate:
    """A mean with its interval, the sample size behind it, and why an interval is absent.

    `ci_omitted_reason` is populated exactly when `ci` is None. A missing interval is
    reported honestly rather than replaced with a fabricated one.
    """

    mean: float | None
    ci: CI | None
    n: int
    ci_omitted_reason: str | None = None

    def as_dict(self) -> dict:
        return {
            "mean": self.mean,
            "ci": self.ci.as_dict() if self.ci else None,
            "n": self.n,
            "ci_omitted_reason": self.ci_omitted_reason,
        }


@dataclass(frozen=True)
class WilcoxonResult:
    statistic: float | None
    p_value: float
    n_pairs: int
    wins: int
    losses: int
    ties: int
    method: str

    def as_dict(self) -> dict:
        return {
            "statistic": self.statistic,
            "p_value": self.p_value,
            "n_pairs": self.n_pairs,
            "wins": self.wins,
            "losses": self.losses,
            "ties": self.ties,
            "method": self.method,
        }


def clean_values(values: Iterable[float | None]) -> np.ndarray:
    """Drop NULLs. Retrieval metrics are NULL by design for unanswerable questions.

    The single definition of "which values count" — every mean and interval in the
    analysis goes through it, so NULL handling cannot drift between payloads.
    """
    return np.asarray([float(v) for v in values if v is not None], dtype=float)


def summarise_latency(values: Iterable[float | None]) -> dict[str, float | int | None]:
    """Five-number summary (+ n, + p95) of a latency stage, in milliseconds.

    Shared by Phase 1 (`phase1.build_config_ranking`) and Phase 2
    (`phase2.build_arm_summary`) so the box-plot data the dashboard reads has one
    percentile convention across both payloads — `np.percentile`, the same one `p95`
    already used here, so `median` stays byte-identical to what was stored before the
    quartiles were added. NULLs are dropped via `clean_values`, never coerced to 0.
    """
    arr = clean_values(values)
    if arr.size == 0:
        return {"n": 0, "min": None, "q1": None, "median": None, "q3": None, "max": None, "p95": None}
    arr = np.sort(arr)
    return {
        "n": int(arr.size),
        "min": float(arr[0]),
        "q1": float(np.percentile(arr, 25)),
        "median": float(np.percentile(arr, 50)),
        "q3": float(np.percentile(arr, 75)),
        "max": float(arr[-1]),
        "p95": float(np.percentile(arr, 95)),
    }


def bca_ci(
    values: Iterable[float | None],
    seed: int = BOOTSTRAP_SEED,
    resamples: int = BOOTSTRAP_RESAMPLES,
) -> tuple[CI | None, str | None]:
    """BCa bootstrap 95% CI for the mean (PRD 11).

    Returns `(None, reason)` rather than raising when the sample cannot support an
    interval. BCa needs the jackknife acceleration term, which is undefined at zero
    variance — a live possibility for a discrete metric at n = 20 (e.g. a config that
    scores +1 on every question).
    """
    return _bca_ci_cleaned(clean_values(values), seed=seed, resamples=resamples)


def _bca_ci_cleaned(
    arr: np.ndarray, seed: int, resamples: int
) -> tuple[CI | None, str | None]:
    if arr.size < 2:
        return None, f"n = {arr.size} (need at least 2)"
    if np.ptp(arr) == 0:
        return None, "zero variance in sample"

    try:
        result = sps.bootstrap(
            (arr,),
            np.mean,
            method="BCa",
            n_resamples=resamples,
            confidence_level=0.95,
            rng=np.random.default_rng(seed),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return None, f"bootstrap failed: {exc}"

    low = float(result.confidence_interval.low)
    high = float(result.confidence_interval.high)
    if not (np.isfinite(low) and np.isfinite(high)):
        return None, "bootstrap produced a non-finite interval"
    return CI(low, high), None


def estimate(values: Iterable[float | None], seed: int = BOOTSTRAP_SEED) -> Estimate:
    """Mean + BCa CI over the non-NULL values, recording the n actually used."""
    arr = clean_values(values)
    if arr.size == 0:
        return Estimate(mean=None, ci=None, n=0, ci_omitted_reason="no non-null values")
    ci, reason = _bca_ci_cleaned(arr, seed=seed, resamples=BOOTSTRAP_RESAMPLES)
    return Estimate(mean=float(arr.mean()), ci=ci, n=int(arr.size), ci_omitted_reason=reason)


def _permutation_method(n_pairs: int):
    """Exhaustive at Phase-1 scale, seeded Monte Carlo beyond it — deterministic either way.

    `method='exact'` is unavailable here because scipy refuses it once zeros or ties are
    present, and with a {-1, 0, +1} metric they always are. A permutation test with
    `n_resamples=inf` enumerates all sign flips instead, giving the same answer.
    """
    n_resamples = np.inf if n_pairs <= EXHAUSTIVE_MAX_PAIRS else MONTE_CARLO_RESAMPLES
    return sps.PermutationMethod(n_resamples=n_resamples, rng=np.random.default_rng(BOOTSTRAP_SEED))


def paired_wilcoxon(a: Sequence[float], b: Sequence[float]) -> WilcoxonResult:
    """Two-sided paired Wilcoxon signed-rank test (PRD 11).

    `zero_method='zsplit'` keeps zero differences in the ranking rather than discarding
    them; dropping them would inflate the apparent effect whenever two configs agree on
    most questions, which is the common case here.
    """
    a_arr = np.asarray(a, dtype=float)
    b_arr = np.asarray(b, dtype=float)
    if a_arr.shape != b_arr.shape:
        raise ValueError(f"paired samples must be the same length: {a_arr.shape} vs {b_arr.shape}")
    if a_arr.size == 0:
        raise ValueError("paired samples must be non-empty")

    diff = a_arr - b_arr
    wins = int(np.sum(diff > 0))
    losses = int(np.sum(diff < 0))
    ties = int(np.sum(diff == 0))

    # All-zero differences: the test is undefined (no signed ranks to permute), but the
    # honest reading is "no evidence of a difference", so report p = 1 rather than raise.
    if wins == 0 and losses == 0:
        return WilcoxonResult(
            statistic=None,
            p_value=1.0,
            n_pairs=int(a_arr.size),
            wins=wins,
            losses=losses,
            ties=ties,
            method="degenerate (all differences zero)",
        )

    method = _permutation_method(int(a_arr.size))
    result = sps.wilcoxon(a_arr, b_arr, zero_method="zsplit", alternative="two-sided", method=method)
    exhaustive = a_arr.size <= EXHAUSTIVE_MAX_PAIRS
    return WilcoxonResult(
        statistic=float(result.statistic),
        p_value=float(result.pvalue),
        n_pairs=int(a_arr.size),
        wins=wins,
        losses=losses,
        ties=ties,
        method="permutation (exhaustive)" if exhaustive else "permutation (monte carlo, seeded)",
    )


def holm(p_values: Sequence[float]) -> list[float]:
    """Holm-Bonferroni adjusted p-values, order-preserving."""
    if len(p_values) == 0:
        return []
    _reject, adjusted, _a, _b = multipletests(list(p_values), method="holm")
    return [float(p) for p in adjusted]
