"""Hermetic tests for the pure statistical primitives. No database, no network."""

from __future__ import annotations

import pytest

from tosrag_analysis.stats import bca_ci, estimate, holm, paired_wilcoxon


class TestHolm:
    def test_worked_example(self):
        # m = 4. Step-down: 4(0.01)=0.04; max(0.04, 3(0.02)=0.06)=0.06;
        # max(0.06, 2(0.03)=0.06)=0.06; max(0.06, 1(0.04)=0.04)=0.06.
        assert holm([0.01, 0.02, 0.03, 0.04]) == pytest.approx([0.04, 0.06, 0.06, 0.06])

    def test_preserves_input_order(self):
        shuffled = holm([0.04, 0.01, 0.03, 0.02])
        assert shuffled == pytest.approx([0.06, 0.04, 0.06, 0.06])

    def test_empty(self):
        assert holm([]) == []

    def test_adjusted_p_never_decreases_significance(self):
        raw = [0.001, 0.02, 0.4]
        assert all(a >= r for a, r in zip(holm(raw), raw))


class TestBcaCi:
    def test_is_deterministic_under_fixed_seed(self):
        values = [0.1, 0.5, 0.3, 0.9, 0.2, 0.7, 0.4, 0.8]
        first, _ = bca_ci(values)
        second, _ = bca_ci(values)
        assert first is not None
        assert (first.low, first.high) == (second.low, second.high)

    def test_interval_brackets_the_mean(self):
        values = [0.1, 0.5, 0.3, 0.9, 0.2, 0.7, 0.4, 0.8]
        ci, reason = bca_ci(values)
        assert reason is None
        assert ci.low < sum(values) / len(values) < ci.high

    def test_zero_variance_returns_no_interval_rather_than_raising(self):
        ci, reason = bca_ci([1.0] * 20)
        assert ci is None
        assert "zero variance" in reason

    def test_too_few_values(self):
        ci, reason = bca_ci([0.5])
        assert ci is None
        assert "need at least 2" in reason

    def test_nulls_are_dropped(self):
        ci, reason = bca_ci([0.5, None, 0.7, None, 0.2, 0.9])
        assert reason is None
        assert ci is not None


class TestEstimate:
    def test_reports_the_n_actually_used(self):
        # Retrieval metrics are NULL for unanswerable questions by design (PRD 10.1),
        # so the n behind the mean must reflect the complete cases only.
        result = estimate([1.0, None, 0.5, None, 0.75, 0.25])
        assert result.n == 4
        assert result.mean == pytest.approx(0.625)

    def test_all_null(self):
        result = estimate([None, None])
        assert result.mean is None
        assert result.n == 0
        assert result.ci is None

    def test_zero_variance_keeps_the_mean_but_drops_the_interval(self):
        result = estimate([1.0] * 20)
        assert result.mean == pytest.approx(1.0)
        assert result.ci is None
        assert result.ci_omitted_reason is not None


class TestPairedWilcoxon:
    def test_all_differences_zero_is_reported_not_raised(self):
        result = paired_wilcoxon([1, 0, -1, 1], [1, 0, -1, 1])
        assert result.p_value == 1.0
        assert result.statistic is None
        assert (result.wins, result.losses, result.ties) == (0, 0, 4)

    def test_maximally_separated_samples(self):
        # Every one of the 10 pairs favours `a`. Under exhaustive sign-flip permutation
        # only 2 of the 2**10 = 1024 assignments are this extreme, so p = 2/1024.
        result = paired_wilcoxon([1] * 10, [0] * 10)
        assert result.wins == 10
        assert result.losses == 0
        assert result.p_value == pytest.approx(2 / 1024, rel=1e-6)
        assert result.method == "permutation (exhaustive)"

    def test_counts_wins_losses_and_ties(self):
        result = paired_wilcoxon([1, 1, 0, -1], [0, 1, 0, 1])
        assert (result.wins, result.losses, result.ties) == (1, 1, 2)

    def test_rejects_mismatched_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            paired_wilcoxon([1, 2, 3], [1, 2])

    def test_rejects_empty(self):
        with pytest.raises(ValueError, match="non-empty"):
            paired_wilcoxon([], [])

    def test_is_deterministic(self):
        a = [1, 0, 1, 1, -1, 0, 1, 1, 0, 1, 1, -1, 0, 1, 1, 1, 0, -1, 1, 1]
        b = [0, 0, 1, -1, -1, 1, 1, 0, 0, 1, -1, -1, 1, 1, 0, 1, 0, -1, 1, 0]
        assert paired_wilcoxon(a, b).p_value == paired_wilcoxon(a, b).p_value
