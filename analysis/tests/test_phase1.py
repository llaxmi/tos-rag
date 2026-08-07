"""Hermetic tests for the Phase-1 payload builders, against a synthetic 15 x 20 frame."""

from __future__ import annotations

import pytest

from tosrag_analysis.phase1 import (
    ANALYSIS_KEYS,
    HEADLINE_METRIC,
    Row,
    ShapeError,
    assert_phase1_shape,
    build_all,
    build_best_vs_rest,
    build_config_ranking,
    build_factor_analysis,
    rank_configs,
)

STRATEGIES = ["fixed", "recursive", "section", "semantic", "sentence"]
SIZES = [128, 256, 512]
QUESTIONS = [f"q{i:02d}" for i in range(20)]

# Exhaustive sign-flip permutation costs 2**n per comparison, so the full 20-question
# grid takes ~3s per Wilcoxon test. Tests that only need the *logic* use a small grid;
# the full-size grid is exercised once, in TestBuildAll.
SMALL_QUESTIONS = [f"q{i:02d}" for i in range(8)]

# Significance has a floor set by n: the smallest attainable two-sided permutation
# p-value is 2/2**n, and Holm multiplies the smallest of 14 comparisons by 14. At n = 8
# that floor is 14 * 2/256 = 0.109, so *no* effect size can be significant. n = 12 gives
# 14 * 2/4096 = 0.007, comfortably under 0.05. The real Phase 1 (n = 20) has ample room.
SEPARABLE_QUESTIONS = [f"q{i:02d}" for i in range(12)]


def make_rows(score_for=None, recall_for=None, latency_for=None, questions=None) -> list[Row]:
    """A complete Phase-1 grid. Callers override the metric a given test cares about."""
    score_for = score_for or (lambda strategy, size, qid: 1.0 if size == 256 else 0.0)
    recall_for = recall_for or (lambda strategy, size, qid: 0.9)
    latency_for = latency_for or (lambda strategy, size, qid: float(size * 10))
    questions = questions or QUESTIONS
    # The last two questions stand in for the unanswerable ones (PRD 10.1).
    unanswerable_ids = set(questions[-2:])

    rows = []
    for strategy in STRATEGIES:
        for size in SIZES:
            for qid in questions:
                unanswerable = qid in unanswerable_ids
                rows.append(
                    Row(
                        strategy=strategy,
                        chunk_size=size,
                        question_id=qid,
                        qtype="unanswerable" if unanswerable else "extractive",
                        crag_score=score_for(strategy, size, qid),
                        # Retrieval metrics are NULL for unanswerable questions (PRD 10.1).
                        char_precision=None if unanswerable else 0.05,
                        char_recall=None if unanswerable else recall_for(strategy, size, qid),
                        hit_at_8=None if unanswerable else 1.0,
                        squad_f1=0.65,
                        squad_em=0.0,
                        retrieval_ms=12.0,
                        generation_ms=latency_for(strategy, size, qid),
                    )
                )
    return rows


class TestShapeAssertion:
    def test_accepts_a_complete_grid(self):
        assert_phase1_shape(make_rows())

    def test_rejects_an_empty_frame(self):
        with pytest.raises(ShapeError, match="no Phase-1 rows"):
            assert_phase1_shape([])

    def test_rejects_a_dropped_config(self):
        # A silently missing config still yields a plausible ranking, which is worse
        # than a crash — this is the assertion that prevents it.
        rows = [r for r in make_rows() if not (r.strategy == "fixed" and r.chunk_size == 128)]
        with pytest.raises(ShapeError, match="expected 15 configs, found 14"):
            assert_phase1_shape(rows)

    def test_rejects_a_config_missing_one_question(self):
        rows = make_rows()
        rows = [r for r in rows if not (r.config == "recursive:256" and r.question_id == "q05")]
        with pytest.raises(ShapeError, match="does not cover the same question set|questions per config"):
            assert_phase1_shape(rows)

    def test_rejects_duplicate_runs(self):
        rows = make_rows()
        with pytest.raises(ShapeError):
            assert_phase1_shape(rows + [rows[0]])


class TestRanking:
    def test_winner_is_computed_from_truthfulness(self):
        rows = make_rows(
            score_for=lambda strategy, size, qid: 1.0 if (strategy, size) == ("recursive", 256) else 0.0
        )
        assert rank_configs(rows)[0] == "recursive:256"

    def test_ties_break_on_char_recall(self):
        # Every config scores identically on Truthfulness, so the tie-break decides.
        rows = make_rows(
            score_for=lambda strategy, size, qid: 1.0,
            recall_for=lambda strategy, size, qid: 0.99 if (strategy, size) == ("section", 512) else 0.5,
        )
        assert rank_configs(rows)[0] == "section:512"

    def test_ties_then_break_on_latency(self):
        rows = make_rows(
            score_for=lambda strategy, size, qid: 1.0,
            recall_for=lambda strategy, size, qid: 0.5,
            latency_for=lambda strategy, size, qid: 1.0 if (strategy, size) == ("fixed", 512) else 9999.0,
        )
        assert rank_configs(rows)[0] == "fixed:512"

    def test_ranking_payload_shape(self):
        payload = build_config_ranking(make_rows())
        assert payload["n_configs"] == 15
        assert len(payload["configs"]) == 15
        assert [c["rank"] for c in payload["configs"]] == list(range(1, 16))
        assert payload["winner"] == payload["configs"][0]["config"]

    def test_null_retrieval_metrics_reduce_only_their_own_n(self):
        payload = build_config_ranking(make_rows())
        metrics = payload["configs"][0]["metrics"]
        # 20 questions, 2 of them unanswerable -> retrieval metrics see 18.
        assert metrics["char_recall"]["n"] == 18
        assert metrics[HEADLINE_METRIC]["n"] == 20

    def test_config_ranking_carries_latency_quartiles(self):
        payload = build_config_ranking(make_rows())
        first = payload["configs"][0]
        assert set(first["latency_ms"]) == {"retrieval_ms", "generation_ms"}
        assert set(first["latency_ms"]["generation_ms"]) == {
            "n", "min", "q1", "median", "q3", "max", "p95",
        }


class TestFactorAnalysis:
    def test_strategy_levels(self):
        rows = make_rows(
            score_for=lambda strategy, size, qid: 1.0 if strategy == "recursive" else 0.0
        )
        payload = build_factor_analysis(rows, "strategy")
        assert payload["n_questions"] == 20
        assert len(payload["levels"]) == 5
        assert payload["levels"][0]["level"] == "recursive"
        assert payload["levels"][0]["estimate"]["mean"] == pytest.approx(1.0)
        assert payload["levels"][0]["n_configs_averaged"] == 3

    def test_size_levels(self):
        payload = build_factor_analysis(make_rows(), "chunk_size")
        assert len(payload["levels"]) == 3
        # The default fixture scores 1.0 only at size 256.
        assert payload["levels"][0]["level"] == 256
        assert payload["levels"][0]["n_configs_averaged"] == 5

    def test_rejects_an_unknown_factor(self):
        with pytest.raises(ValueError, match="strategy"):
            build_factor_analysis(make_rows(), "qtype")


@pytest.fixture(scope="module")
def separated_payload():
    rows = make_rows(
        score_for=lambda strategy, size, qid: 1.0 if (strategy, size) == ("recursive", 256) else -1.0,
        questions=SEPARABLE_QUESTIONS,
    )
    return build_best_vs_rest(rows)


class TestBestVsRest:
    def test_reports_fourteen_holm_corrected_comparisons(self, separated_payload):
        assert separated_payload["winner"] == "recursive:256"
        assert separated_payload["n_comparisons"] == 14
        assert all("p_holm" in c for c in separated_payload["comparisons"])
        assert all(c["p_holm"] >= c["p_raw"] for c in separated_payload["comparisons"])

    def test_a_real_separation_is_detected(self, separated_payload):
        # Every question favours the winner by 2 points, so even after Holm correction
        # across 14 comparisons the separation survives.
        assert separated_payload["n_significant"] == 14

    def test_significance_has_a_floor_set_by_sample_size(self):
        # Worth pinning down because it is the crux of the Phase-1 caveat: with a perfect
        # 2-point separation on every question, n = 8 still yields nothing significant,
        # because Holm x 14 cannot get 2/2**8 below 0.05. Small n, not a weak effect.
        rows = make_rows(
            score_for=lambda strategy, size, qid: 1.0 if (strategy, size) == ("recursive", 256) else -1.0,
            questions=SMALL_QUESTIONS,
        )
        payload = build_best_vs_rest(rows)
        assert payload["n_significant"] == 0
        assert all(c["p_raw"] == pytest.approx(2 / 2**8) for c in payload["comparisons"])

    def test_identical_configs_are_not_separable(self):
        rows = make_rows(score_for=lambda strategy, size, qid: 1.0, questions=SMALL_QUESTIONS)
        payload = build_best_vs_rest(rows)
        assert payload["n_significant"] == 0
        assert all(c["wilcoxon"]["ties"] == len(SMALL_QUESTIONS) for c in payload["comparisons"])

    def test_missing_headline_score_is_rejected_not_coerced(self):
        # 0.0 is a real CRAG score (Missing/abstention), so a NULL must never become one.
        rows = make_rows(questions=SMALL_QUESTIONS)
        rows = [
            Row(**{**r.__dict__, "crag_score": None})
            if (r.config == "recursive:256" and r.question_id == "q03")
            else r
            for r in rows
        ]
        with pytest.raises(ShapeError, match="complete pair"):
            build_best_vs_rest(rows)


@pytest.fixture(scope="module")
def full_payloads():
    """The real 15 x 20 Phase-1 grid, built once — this is the expensive path."""
    return build_all(make_rows())


class TestBuildAll:
    def test_produces_every_analysis_key(self, full_payloads):
        assert set(full_payloads) == set(ANALYSIS_KEYS)

    def test_is_json_serialisable(self, full_payloads):
        import json

        json.dumps(full_payloads)

    def test_rejects_a_grid_that_is_not_phase_one(self):
        with pytest.raises(ShapeError):
            build_all(make_rows(questions=SMALL_QUESTIONS))

    def test_accepts_an_explicit_grid_size(self):
        # Phase 2 will run the full 30-question set, so the expected grid is a parameter.
        payloads = build_all(make_rows(questions=SMALL_QUESTIONS), expected_questions=8)
        assert set(payloads) == set(ANALYSIS_KEYS)

    def test_is_deterministic(self):
        import json

        rows = make_rows(questions=SMALL_QUESTIONS)
        first = json.dumps(build_all(rows, expected_questions=8), sort_keys=True)
        second = json.dumps(build_all(rows, expected_questions=8), sort_keys=True)
        assert first == second
