"""Hermetic tests for judge validation. No database, no network, no files."""

from __future__ import annotations

import pytest

from tosrag_analysis.judge import (
    ACCURATE,
    INCORRECT,
    KAPPA_GATE,
    JudgedRow,
    JudgeValidationError,
    agreement_rate,
    build_validation_payload,
    cohens_kappa,
    draw_sample,
    kappa_band,
    kappa_ci,
    normalise_label,
)

QTYPES = ("factual", "multi_clause", "comparison")


def make_row(run_id: int, score: int, qtype: str = "factual") -> JudgedRow:
    return JudgedRow(
        run_id=run_id,
        phase=1,
        model="llama3.1:8b",
        config="recursive:256",
        question_id=f"q{run_id:03d}",
        qtype=qtype,
        question="q?",
        expected_answer="expected",
        answer="given",
        judge_score=score,
        judge_explanation="because",
    )


def population(n_accurate: int = 60, n_incorrect: int = 40) -> list[JudgedRow]:
    rows = [make_row(i, 1, QTYPES[i % len(QTYPES)]) for i in range(n_accurate)]
    rows += [
        make_row(1000 + i, -1, QTYPES[i % len(QTYPES)]) for i in range(n_incorrect)
    ]
    return rows


class TestNormaliseLabel:
    @pytest.mark.parametrize("raw", ["accurate", "Accurate", " RIGHT ", "y", "1", "+1"])
    def test_accepts_accurate_spellings(self, raw):
        assert normalise_label(raw, where="x") == ACCURATE

    @pytest.mark.parametrize("raw", ["incorrect", "WRONG", "n", "-1"])
    def test_accepts_incorrect_spellings(self, raw):
        assert normalise_label(raw, where="x") == INCORRECT

    def test_blank_is_an_error_naming_the_row(self):
        with pytest.raises(JudgeValidationError, match="line 7"):
            normalise_label("   ", where="sheet line 7")

    def test_typo_is_rejected_rather_than_guessed(self):
        # "maybe" must not silently become a label; it would corrupt the kappa.
        with pytest.raises(JudgeValidationError, match="not a label"):
            normalise_label("maybe", where="x")


class TestDrawSample:
    def test_is_balanced_by_judge_verdict_not_proportional(self):
        picked = draw_sample(population(), n=20)
        accurate = sum(1 for r in picked if r.judge_score > 0)
        assert len(picked) == 20
        assert accurate == 10  # not 12, which proportional sampling would give

    def test_is_deterministic_under_a_fixed_seed(self):
        first = [r.run_id for r in draw_sample(population(), n=20, seed=42)]
        second = [r.run_id for r in draw_sample(population(), n=20, seed=42)]
        assert first == second

    def test_a_different_seed_draws_a_different_sample(self):
        first = [r.run_id for r in draw_sample(population(), n=20, seed=42)]
        other = [r.run_id for r in draw_sample(population(), n=20, seed=7)]
        assert first != other

    def test_spreads_across_question_types(self):
        picked = draw_sample(population(), n=30)
        seen = {row.qtype for row in picked}
        assert seen == set(QTYPES)

    def test_row_order_leaks_no_verdict_signal(self):
        # Ordered by run_id, so the sheet is not accurates-then-incorrects.
        picked = draw_sample(population(), n=20)
        assert [r.run_id for r in picked] == sorted(r.run_id for r in picked)

    def test_refuses_when_the_scarce_verdict_cannot_fill_its_half(self):
        with pytest.raises(JudgeValidationError, match="only 3 rows judged"):
            draw_sample(population(n_accurate=60, n_incorrect=3), n=20)

    def test_rejects_a_nonpositive_size(self):
        with pytest.raises(JudgeValidationError):
            draw_sample(population(), n=0)

    def test_never_repeats_a_row(self):
        picked = draw_sample(population(), n=40)
        assert len({row.run_id for row in picked}) == 40


class TestCohensKappa:
    def test_perfect_agreement_is_one(self):
        labels = [ACCURATE, INCORRECT, ACCURATE, INCORRECT]
        assert cohens_kappa(labels, labels) == pytest.approx(1.0)

    def test_worked_example(self):
        # a: A A A I ; b: A A I I  -> po = 0.75
        # pe = (3/4)(2/4) + (1/4)(2/4) = 0.375 + 0.125 = 0.5 ; k = 0.25/0.5 = 0.5
        a = [ACCURATE, ACCURATE, ACCURATE, INCORRECT]
        b = [ACCURATE, ACCURATE, INCORRECT, INCORRECT]
        assert cohens_kappa(a, b) == pytest.approx(0.5)

    def test_total_disagreement_is_negative(self):
        a = [ACCURATE, ACCURATE, INCORRECT, INCORRECT]
        b = [INCORRECT, INCORRECT, ACCURATE, ACCURATE]
        assert cohens_kappa(a, b) == pytest.approx(-1.0)

    def test_is_undefined_rather_than_zero_when_one_label_is_used_throughout(self):
        # The kappa paradox: 100% agreement but no variance to correct for.
        labels = [ACCURATE] * 6
        assert agreement_rate(labels, labels) == 1.0
        assert cohens_kappa(labels, labels) is None

    def test_is_symmetric(self):
        a = [ACCURATE, INCORRECT, ACCURATE, ACCURATE, INCORRECT]
        b = [ACCURATE, ACCURATE, ACCURATE, INCORRECT, INCORRECT]
        assert cohens_kappa(a, b) == pytest.approx(cohens_kappa(b, a))

    def test_high_agreement_on_skewed_marginals_still_yields_a_low_kappa(self):
        # The reason the sample is balanced by verdict rather than drawn
        # proportionally: 90% agreement, but the disagreements land in the rare
        # label, so pe is huge and kappa lands at 0.444 — under the gate.
        #   34 A/A agree, 2 I/I agree, 2 I/A and 2 A/I disagree.
        a = [ACCURATE] * 34 + [INCORRECT] * 2 + [INCORRECT] * 2 + [ACCURATE] * 2
        b = [ACCURATE] * 34 + [INCORRECT] * 2 + [ACCURATE] * 2 + [INCORRECT] * 2
        assert agreement_rate(a, b) == pytest.approx(0.9)
        assert cohens_kappa(a, b) == pytest.approx(0.444, abs=1e-3)
        assert cohens_kappa(a, b) < KAPPA_GATE

    def test_mismatched_lengths_are_an_error(self):
        with pytest.raises(JudgeValidationError, match="differ in length"):
            cohens_kappa([ACCURATE], [ACCURATE, INCORRECT])

    def test_empty_is_an_error(self):
        with pytest.raises(JudgeValidationError, match="no labels"):
            cohens_kappa([], [])


class TestKappaBand:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (-0.2, "poor"),
            (0.10, "slight"),
            (0.35, "fair"),
            (0.55, "moderate"),
            (0.75, "substantial"),
            (0.95, "almost perfect"),
        ],
    )
    def test_landis_koch_bands(self, value, expected):
        assert kappa_band(value) == expected

    def test_the_gate_sits_at_the_bottom_of_substantial(self):
        assert kappa_band(KAPPA_GATE) == "substantial"

    def test_undefined_is_named_not_guessed(self):
        assert kappa_band(None) == "undefined"


class TestKappaCi:
    def test_is_deterministic_under_the_fixed_seed(self):
        a = [ACCURATE, INCORRECT] * 10
        b = [ACCURATE, INCORRECT] * 9 + [INCORRECT, ACCURATE]
        first = kappa_ci(a, b, resamples=200)
        second = kappa_ci(a, b, resamples=200)
        assert first is not None
        assert (first.low, first.high) == (second.low, second.high)

    def test_brackets_the_point_estimate(self):
        a = [ACCURATE, INCORRECT] * 10
        b = [ACCURATE, INCORRECT] * 9 + [INCORRECT, ACCURATE]
        ci = kappa_ci(a, b, resamples=500)
        point = cohens_kappa(a, b)
        assert ci is not None and ci.low <= point <= ci.high


class TestBuildValidationPayload:
    def rows_and_labels(self, judge_scores, human_labels):
        rows = [make_row(i, s) for i, s in enumerate(judge_scores)]
        return rows, human_labels

    def test_gate_passes_on_strong_agreement(self):
        scores = [1] * 10 + [-1] * 10
        human = [ACCURATE] * 10 + [INCORRECT] * 10
        rows, final = self.rows_and_labels(scores, human)
        payload = build_validation_payload(rows, final, final, final)
        assert payload["judge_vs_human"]["kappa"] == pytest.approx(1.0)
        assert payload["gate"]["passes"] is True

    def test_gate_fails_and_says_what_to_do(self):
        scores = [1] * 10 + [-1] * 10
        # Humans disagree with the judge on a third of the rows.
        human = [ACCURATE] * 4 + [INCORRECT] * 6 + [INCORRECT] * 9 + [ACCURATE]
        rows, final = self.rows_and_labels(scores, human)
        payload = build_validation_payload(rows, final, final, final)
        assert payload["gate"]["passes"] is False
        assert "iterating the judge prompt" in payload["gate"]["interpretation"]

    def test_reports_both_kappas_separately(self):
        scores = [1] * 6 + [-1] * 6
        a = [ACCURATE] * 6 + [INCORRECT] * 6
        b = [ACCURATE] * 5 + [INCORRECT] + [INCORRECT] * 6
        rows = [make_row(i, s) for i, s in enumerate(scores)]
        payload = build_validation_payload(rows, a, b, a)
        assert payload["inter_annotator"]["kappa"] < payload["judge_vs_human"]["kappa"]

    def test_records_the_stratification_caveat(self):
        scores = [1] * 4 + [-1] * 4
        labels = [ACCURATE] * 4 + [INCORRECT] * 4
        rows = [make_row(i, s) for i, s in enumerate(scores)]
        payload = build_validation_payload(rows, labels, labels, labels)
        assert any("balanced" in c for c in payload["caveats"])
        assert payload["sample"]["by_judge_label"] == {ACCURATE: 4, INCORRECT: 4}
