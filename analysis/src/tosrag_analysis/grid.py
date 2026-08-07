"""The shape check and the row-frame primitives both phases share.

Phase 1 and Phase 2 differ only in what groups their grid: 15 configs x 20
questions for one, 2 models x 30 questions for the other. The *check* is the
same four assertions in both cases, so it lives here once rather than being
copied and left to drift — the two copies had already diverged in wording, which
meant an operator got different diagnostics for the same defect depending on
which phase they were running.

Fail loudly before computing anything: a silently missing config or an unpaired
question does not error in a mean or a paired test, it just shifts the answer.
A wrong ranking is far more damaging than a crash. Same reasoning as
`plan-ingest.ts` asserting full tiling rather than only the offset invariant.
"""

from __future__ import annotations

from typing import Callable, Iterable, Protocol, Sequence, TypeVar

from .stats import clean_values


class ShapeError(RuntimeError):
    """The loaded rows are not a complete grid for their phase."""


class _Row(Protocol):
    question_id: str

    def metric(self, name: str) -> float | None: ...


R = TypeVar("R", bound=_Row)


def values(rows: Iterable[R], metric: str) -> list[float | None]:
    """Metric column, NULLs preserved — never coerced to a number (PRD 11)."""
    return [r.metric(metric) for r in rows]


def mean_or_none(vals: Iterable[float | None]) -> float | None:
    """Mean over the present values, or None when there are none.

    None is not 0: for `crag_score`, 0 is a real score (Missing/abstention), so a
    substituted zero would fabricate an abstention that never happened.
    """
    present = clean_values(vals)
    return float(present.mean()) if present.size else None


def group_by(rows: Sequence[R], key: Callable[[R], str]) -> dict[str, list[R]]:
    """Group rows by `key`, each group sorted by question id so the groups are
    positionally aligned and can be paired index-by-index."""
    grouped: dict[str, list[R]] = {}
    for row in rows:
        grouped.setdefault(key(row), []).append(row)
    return {k: sorted(rs, key=lambda r: r.question_id) for k, rs in grouped.items()}


def assert_complete_grid(
    rows: Sequence[R],
    *,
    key: Callable[[R], str],
    noun: str,
    noun_plural: str,
    expected_groups: int | Sequence[str],
    expected_questions: int,
    phase_label: str,
    run_command: str,
) -> None:
    """Assert `rows` is a complete group x question grid.

    `expected_groups` is a count when the group keys are derived (Phase 1's 15
    configs) and an explicit sequence when they are frozen and nameable (Phase
    2's two models) — naming them lets the error say *which* arm is missing.
    """
    if not rows:
        raise ShapeError(
            f"no {phase_label} rows found — has {run_command} been run against this database?"
        )

    groups = sorted({key(r) for r in rows})
    if isinstance(expected_groups, int):
        expected_count = expected_groups
        if len(groups) != expected_count:
            raise ShapeError(
                f"expected {expected_count} {noun_plural}, found {len(groups)}: {groups}"
            )
    else:
        expected_count = len(expected_groups)
        if groups != sorted(expected_groups):
            raise ShapeError(
                f"expected {noun_plural} {sorted(expected_groups)}, found {groups}"
            )

    questions = {g: sorted(r.question_id for r in rows if key(r) == g) for g in groups}
    reference = questions[groups[0]]
    if len(reference) != expected_questions:
        raise ShapeError(
            f"expected {expected_questions} questions per {noun}, "
            f"{noun} {groups[0]} has {len(reference)}"
        )
    for group, qs in questions.items():
        if qs != reference:
            missing = sorted(set(reference) - set(qs))
            extra = sorted(set(qs) - set(reference))
            raise ShapeError(
                f"{noun} {group} does not cover the same question set as {groups[0]} "
                f"(missing: {missing}, unexpected: {extra}) — "
                "the paired tests require identical pairing"
            )

    if len(rows) != expected_count * expected_questions:
        raise ShapeError(
            f"expected {expected_count * expected_questions} rows, got {len(rows)} "
            f"(duplicate runs for the same {noun}/question?)"
        )
