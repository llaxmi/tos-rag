"""Hermetic tests for the Phase-2 payload builders, against a synthetic 2 x N frame."""

from __future__ import annotations

import pytest

from tosrag_analysis import phase2
from tosrag_analysis.phase2 import (
    ANALYSIS_KEYS,
    BASELINE_MODEL,
    RETRIEVAL_METRICS,
    TREATMENT_MODEL,
    TESTED_METRICS,
    Phase2Row,
    ShapeError,
    _floor_note,
    assert_phase2_shape,
    build_abstention,
    build_all,
    build_arm_summary,
    build_cost_effectiveness,
    build_outcome_buckets,
    build_paired_analysis,
    build_paired_comparisons,
    build_retrieval_identity,
    build_subset,
    build_win_counts,
    is_abstention,
    pair_metric,
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
            # right and left single quotes (U+2019, U+2018), written as escapes so
            # the source stays ASCII and cannot be flattened by an editor round-trip
            "I don\u2019t know",
            "I don\u2019t know.",
            "I don\u2018t know",
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


class TestFloorNote:
    """Pins the rendered floor_note string byte-for-byte.

    Guards against the discordant = 0 defect (2026-08-05): the general formula
    2/2**discordant is 2 at discordant = 0, but `_permutation_floor` caps its result
    at 1.0 for the alpha comparison, and the note used to print that capped value as
    if it were the literal fraction -- rendering the false equation "2/2**0 = 1".
    """

    def test_discordant_zero_never_states_the_false_equation(self):
        note = _floor_note(0, 30, 0.05)
        assert "2/2**0 = 1" not in note
        assert "2/2**0" not in note

    def test_discordant_zero_reads_sensibly(self):
        note = _floor_note(0, 30, 0.05)
        assert "no discordant pairs" in note
        assert "no evidence of a difference" in note
        assert "cannot attain a two-sided p below 1" in note

    def test_discordant_one_renders_the_true_fraction(self):
        # 2/2**1 = 1 is true even uncapped, so this rendering was never broken.
        note = _floor_note(1, 29, 0.05)
        assert "2/2**1 = 1" in note

    def test_discordant_five_matches_the_stored_crag_score_note(self):
        # Quoted verbatim in docs/report-notes.md and in the stored analysis_results
        # payload for crag_score -- must render byte-for-byte.
        assert _floor_note(5, 25, 0.05) == (
            "5 discordant pairs (25 ties) bound the two-sided p at 2/2**5 = 0.0625, "
            "above alpha = 0.05: no effect size could reach significance at this "
            "discordance count. 6 discordant pairs would be needed."
        )

    def test_discordant_28_does_not_claim_no_effect_size_possible(self):
        # cosine_sim's real discordant count: the floor is far below alpha, so the
        # note must not claim significance is unreachable at this count.
        note = _floor_note(28, 2, 0.05)
        assert "no effect size could reach significance" not in note
        assert "at or below alpha" in note


class TestFloorNoteInPayload:
    def test_floor_note_and_explanation_are_present(self, separated_comparisons):
        # A future refactor that drops either key should fail loudly here rather than
        # silently stop reporting the permutation-floor caveat.
        assert "floor_note_explanation" in separated_comparisons
        assert separated_comparisons["floor_note_explanation"]
        for entry in separated_comparisons["metrics"]:
            if entry["p_raw"] is not None:
                assert "floor_note" in entry
                assert entry["floor_note"]


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
        # Each stage is now a five-number summary (+ n, + p95), not just median/p95 —
        # the box plot needs q1/q3 too.
        assert set(latency["generation_ms"]) == {
            "n", "min", "q1", "median", "q3", "max", "p95",
        }
        assert latency["generation_ms"]["median"] == pytest.approx(1000.0)
        assert latency["generation_ms"]["p95"] == pytest.approx(1000.0)
        assert latency["retrieval_ms"]["n"] == 10


class TestLatencySummary:
    def test_reports_five_number_summary(self):
        values = [10.0, 20.0, 30.0, 40.0, 50.0]
        got = phase2._summarise_latency(values)
        assert got["n"] == 5
        assert got["min"] == 10.0
        assert got["q1"] == 20.0
        assert got["median"] == 30.0
        assert got["q3"] == 40.0
        assert got["max"] == 50.0

    def test_is_ordered(self):
        got = phase2._summarise_latency([50.0, 10.0, 30.0, 20.0, 40.0])
        assert got["min"] <= got["q1"] <= got["median"] <= got["q3"] <= got["max"]

    def test_handles_single_run(self):
        got = phase2._summarise_latency([42.0])
        assert got["n"] == 1
        assert got["min"] == got["q1"] == got["median"] == got["q3"] == got["max"] == 42.0

    def test_cost_totals_and_token_counts(self):
        summary = build_arm_summary(make_rows(questions=SMALL_QUESTIONS))
        assert summary[TREATMENT_MODEL]["cost"]["total_usd"] == pytest.approx(0.2)
        assert summary[TREATMENT_MODEL]["cost"]["mean_usd_per_run"] == pytest.approx(0.02)
        assert summary[TREATMENT_MODEL]["cost"]["input_tokens"] == 1000
        assert summary[TREATMENT_MODEL]["cost"]["output_tokens"] == 200
        # A locally served model costs $0 in API terms, and that is the finding, not
        # a missing measurement — so it is 0.0, never None.
        assert summary[BASELINE_MODEL]["cost"]["total_usd"] == pytest.approx(0.0)


class TestCostEffectiveness:
    """Cost against quality — the only framing in which the paid arm's bill is a finding."""

    def _mixed_rows(self):
        """Treatment correct everywhere; baseline wrong on the first two questions.

        Mirrors the real frame's shape (the treatment arm fixes a handful of the
        baseline's errors) at a size the assertions can state exactly.
        """
        return make_rows(
            questions=SMALL_QUESTIONS,
            score_for=lambda model, qid: (
                1.0
                if model == TREATMENT_MODEL
                else (-1.0 if qid in SMALL_QUESTIONS[:2] else 1.0)
            ),
        )

    def test_reports_cost_per_correct_answer_not_just_a_total(self):
        payload = build_cost_effectiveness(self._mixed_rows())
        treatment = payload["arms"][TREATMENT_MODEL]
        assert treatment["n_correct"] == 10
        assert treatment["total_usd"] == pytest.approx(0.2)
        assert treatment["usd_per_correct_answer"] == pytest.approx(0.02)

        baseline = payload["arms"][BASELINE_MODEL]
        assert baseline["n_correct"] == 8
        # $0 per correct answer is the finding for a locally served model, not a gap.
        assert baseline["usd_per_correct_answer"] == pytest.approx(0.0)

    def test_marginal_price_of_the_accuracy_the_treatment_buys(self):
        payload = build_cost_effectiveness(self._mixed_rows())
        marginal = payload["marginal"]
        assert marginal["additional_correct_answers"] == 2
        assert marginal["additional_usd"] == pytest.approx(0.2)
        assert marginal["usd_per_additional_correct_answer"] == pytest.approx(0.1)

    def test_no_additional_correct_answers_leaves_the_marginal_price_undefined(self):
        # Both arms correct everywhere: the treatment bought nothing, and a per-correction
        # price would be a division by zero dressed up as a measurement.
        payload = build_cost_effectiveness(make_rows(
            questions=SMALL_QUESTIONS,
            score_for=lambda model, qid: 1.0,
        ))
        assert payload["marginal"]["additional_correct_answers"] == 0
        assert payload["marginal"]["usd_per_additional_correct_answer"] is None

    def test_splits_the_bill_into_input_and_output(self):
        # 10 runs x 100 input tokens at $5/Mtok = $0.005; 10 x 20 output at $25 = $0.005.
        payload = build_cost_effectiveness(self._mixed_rows())
        treatment = payload["arms"][TREATMENT_MODEL]
        assert treatment["input_usd"] == pytest.approx(0.005)
        assert treatment["output_usd"] == pytest.approx(0.005)
        assert treatment["input_share"] == pytest.approx(0.5)

    def test_a_free_arm_has_no_meaningful_input_share(self):
        payload = build_cost_effectiveness(self._mixed_rows())
        baseline = payload["arms"][BASELINE_MODEL]
        assert baseline["input_usd"] == pytest.approx(0.0)
        assert baseline["input_share"] is None

    def test_recomputed_total_is_checked_against_the_stored_one(self):
        # The fixture's stored $0.02/run does not match the price table applied to its
        # token counts ($0.001/run), and the payload must say so rather than quietly
        # publishing a split that does not add up to the stored bill.
        payload = build_cost_effectiveness(self._mixed_rows())
        treatment = payload["arms"][TREATMENT_MODEL]
        assert treatment["recomputed_total_usd"] == pytest.approx(0.01)
        assert treatment["recomputed_matches_stored"] is False

    def test_recomputed_matches_when_stored_cost_follows_the_price_table(self):
        payload = build_cost_effectiveness(make_rows(
            questions=SMALL_QUESTIONS,
            # 100 input at $5/Mtok + 20 output at $25/Mtok = $0.001 per run.
            cost_for=lambda model, qid: 0.001 if model == TREATMENT_MODEL else 0.0,
        ))
        assert payload["arms"][TREATMENT_MODEL]["recomputed_matches_stored"] is True
        assert payload["arms"][BASELINE_MODEL]["recomputed_matches_stored"] is True


class TestOutcomeBuckets:
    def test_every_question_lands_in_exactly_one_bucket(self):
        rows = make_rows(
            questions=SMALL_QUESTIONS,
            score_for=lambda model, qid: (
                1.0
                if model == TREATMENT_MODEL
                else (-1.0 if qid in SMALL_QUESTIONS[:2] else 1.0)
            ),
        )
        buckets = build_outcome_buckets(rows)
        assert [b["bucket"] for b in buckets] == [
            "both_correct", "treatment_only", "baseline_only", "neither",
        ]
        assert sum(b["n_questions"] for b in buckets) == len(SMALL_QUESTIONS)
        assert not set().intersection(*[set(b["question_ids"]) for b in buckets])

        by_name = {b["bucket"]: b for b in buckets}
        assert by_name["treatment_only"]["question_ids"] == SMALL_QUESTIONS[:2]
        assert by_name["both_correct"]["n_questions"] == 8
        assert by_name["neither"]["n_questions"] == 0

    def test_abstention_is_not_correct_but_is_kept_apart_from_a_hallucination(self):
        # 0 is a real CRAG score (Missing), so it is "not correct" here — but the bucket
        # it lands in must be the same one -1 lands in only when both arms fail.
        rows = make_rows(
            questions=SMALL_QUESTIONS,
            score_for=lambda model, qid: (
                0.0 if model == TREATMENT_MODEL and qid == SMALL_QUESTIONS[0] else 1.0
            ),
        )
        by_name = {b["bucket"]: b for b in build_outcome_buckets(rows)}
        assert by_name["baseline_only"]["question_ids"] == [SMALL_QUESTIONS[0]]

    def test_reports_answer_length_per_arm_within_each_bucket(self):
        rows = make_rows(questions=SMALL_QUESTIONS)
        by_name = {b["bucket"]: b for b in build_outcome_buckets(rows)}
        treatment_only = by_name["treatment_only"]
        assert treatment_only["n_questions"] == len(SMALL_QUESTIONS)
        assert treatment_only[TREATMENT_MODEL]["mean_output_tokens"] == pytest.approx(20.0)
        assert treatment_only[TREATMENT_MODEL]["mean_usd_per_run"] == pytest.approx(0.02)

    def test_an_empty_bucket_reports_none_rather_than_zero_tokens(self):
        # A bucket with no questions has no mean answer length; 0.0 would read as
        # "the model answered with nothing".
        by_name = {b["bucket"]: b for b in build_outcome_buckets(make_rows(questions=SMALL_QUESTIONS))}
        assert by_name["neither"]["n_questions"] == 0
        assert by_name["neither"][TREATMENT_MODEL]["mean_output_tokens"] is None

    def test_a_null_headline_score_raises_rather_than_vanishing_from_the_buckets(self):
        rows = make_rows(
            questions=SMALL_QUESTIONS,
            score_for=lambda model, qid: (
                None if model == BASELINE_MODEL and qid == SMALL_QUESTIONS[0] else 1.0
            ),
        )
        with pytest.raises(ShapeError, match="crag_score is NULL"):
            build_outcome_buckets(rows)


class TestRetrievalIdentity:
    def test_identical_retrieval_is_detected(self):
        payload = build_retrieval_identity(make_rows(questions=SMALL_QUESTIONS))
        assert payload["identical"] is True
        assert set(payload["metrics"]) == set(RETRIEVAL_METRICS)
        assert payload["metrics"]["char_recall"]["n_differing"] == 0
        assert payload["metrics"]["char_recall"]["treatment_estimate"]["mean"] == pytest.approx(0.99)

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
