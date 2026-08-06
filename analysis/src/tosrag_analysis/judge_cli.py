"""`judge-sample` and `judge-kappa` — the two machine halves of judge validation.

The human half sits between them: two annotators independently label the sheets that
`judge-sample` writes, then `judge-kappa` reads them back.

    uv run judge-sample                 # writes the blinded sheets + the answer key
    # ... both annotators fill in the `label` column of their own sheet ...
    uv run judge-kappa                  # inter-annotator kappa + the rows to adjudicate
    # ... adjudicate the disagreements into judge-sample-final.csv ...
    uv run judge-kappa                  # judge-vs-human kappa, and the gate verdict

Blinding is the point of the split: the sheets carry no judge verdict, no model, and no
config, and the rows are ordered by run id so the verdict cannot be read off the layout.
An annotator who can see the judge's answer will anchor to it, and the kappa that comes
out the far end would measure nothing.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Sequence

from . import db, judge
from .judge import JudgeValidationError, JudgedRow

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "judge-validation"

SHEET_COLUMNS = (
    "sample_id",
    "question_id",
    "qtype",
    "question",
    "expected_answer",
    "generated_answer",
    "label",
)
KEY_COLUMNS = (
    "sample_id",
    "run_id",
    "phase",
    "model",
    "config",
    "question_id",
    "judge_score",
    "judge_explanation",
)
ANNOTATORS = ("a", "b")


def _sheet_path(directory: Path, who: str) -> Path:
    return directory / f"judge-sample-{who}.csv"


def _key_path(directory: Path) -> Path:
    return directory / "judge-sample-key.csv"


def _final_path(directory: Path) -> Path:
    return directory / "judge-sample-final.csv"


def _write_sheets(rows: Sequence[JudgedRow], directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    for who in ANNOTATORS:
        path = _sheet_path(directory, who)
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(SHEET_COLUMNS)
            for index, row in enumerate(rows, start=1):
                writer.writerow(
                    [
                        index,
                        row.question_id,
                        row.qtype,
                        row.question,
                        row.expected_answer,
                        row.answer,
                        "",
                    ]
                )
        written.append(path)

    key = _key_path(directory)
    with key.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(KEY_COLUMNS)
        for index, row in enumerate(rows, start=1):
            writer.writerow(
                [
                    index,
                    row.run_id,
                    row.phase,
                    row.model,
                    row.config,
                    row.question_id,
                    row.judge_score,
                    row.judge_explanation,
                ]
            )
    written.append(key)
    return written


def _read_labels(path: Path) -> dict[int, str]:
    if not path.is_file():
        raise JudgeValidationError(f"{path} does not exist — run `uv run judge-sample` first")
    labels: dict[int, str] = {}
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or ()
        if "label" not in fields or "sample_id" not in fields:
            raise JudgeValidationError(f"{path}: expected `sample_id` and `label` columns")
        for line_no, record in enumerate(reader, start=2):
            where = f"{path.name} line {line_no}"
            labels[int(record["sample_id"])] = judge.normalise_label(
                record["label"] or "", where=where
            )
    if not labels:
        raise JudgeValidationError(f"{path} has no rows")
    return labels


def _load_key(directory: Path, rows: Sequence[JudgedRow]) -> list[JudgedRow]:
    """Re-orders live rows to match the emitted sample, so ids can never drift."""
    key = _key_path(directory)
    if not key.is_file():
        raise JudgeValidationError(f"{key} does not exist — run `uv run judge-sample` first")
    by_run_id = {row.run_id: row for row in rows}
    ordered: list[JudgedRow] = []
    with key.open(newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            run_id = int(record["run_id"])
            if run_id not in by_run_id:
                raise JudgeValidationError(
                    f"run {run_id} is in the key but no longer in the database — the runs "
                    "were re-scored or re-collected after sampling; re-draw the sample"
                )
            ordered.append(by_run_id[run_id])
    return ordered


def sample_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="judge-sample",
        description="Draw a blinded, verdict-balanced sample for judge validation (PRD 10.3).",
    )
    parser.add_argument("--n", type=int, default=50, help="sample size (default 50, PRD asks >= 40)")
    parser.add_argument("--out", type=Path, default=DEFAULT_DIR, help="output directory")
    parser.add_argument("--seed", type=int, default=judge.SAMPLE_SEED, help="sampling seed")
    parser.add_argument("--database-url", default=None, help="override DATABASE_URL")
    args = parser.parse_args(argv)

    try:
        dsn = db.resolve_dsn(args.database_url)
        rows = db.load_judged_rows(dsn)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"{len(rows)} judged rows available")
    try:
        picked = judge.draw_sample(rows, n=args.n, seed=args.seed)
    except JudgeValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if any(_sheet_path(args.out, who).exists() for who in ANNOTATORS):
        print(
            f"error: sheets already exist in {args.out} — labelling them twice would "
            "silently discard work. Move or delete them first.",
            file=sys.stderr,
        )
        return 1

    written = _write_sheets(picked, args.out)
    counts = judge._counts(row.qtype for row in picked)
    print(f"sampled {len(picked)}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    print(f"balanced by verdict: {args.n // 2} accurate, {args.n // 2} incorrect")
    print()
    for path in written:
        print(f"  wrote {path}")
    print()
    print("Next: each annotator fills the `label` column of their OWN sheet with")
    print("`accurate` or `incorrect` (right/wrong also accepted). Do not open the key,")
    print("and do not compare notes until both sheets are complete.")
    return 0


def kappa_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="judge-kappa",
        description="Cohen's kappa for judge validation (PRD 10.3) and annotator agreement (PRD 6).",
    )
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="directory holding the sheets")
    parser.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    parser.add_argument("--json", action="store_true", help="print the full payload as JSON")
    parser.add_argument("--database-url", default=None, help="override DATABASE_URL")
    args = parser.parse_args(argv)

    try:
        dsn = db.resolve_dsn(args.database_url)
        rows = _load_key(args.dir, db.load_judged_rows(dsn))
        labels_a = _read_labels(_sheet_path(args.dir, "a"))
        labels_b = _read_labels(_sheet_path(args.dir, "b"))
    except JudgeValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    ids = sorted(labels_a)
    if sorted(labels_b) != ids or len(ids) != len(rows):
        print(
            f"error: the two sheets and the key disagree about which rows exist "
            f"({len(labels_a)}, {len(labels_b)}, {len(rows)}) — do not edit sample_id",
            file=sys.stderr,
        )
        return 1

    a = [labels_a[i] for i in ids]
    b = [labels_b[i] for i in ids]

    inter_kappa = judge.cohens_kappa(a, b)
    disagreements = [i for i in ids if labels_a[i] != labels_b[i]]
    print(
        f"inter-annotator: {judge.agreement_rate(a, b):.1%} agreement, "
        f"kappa = {_fmt(inter_kappa)} ({judge.kappa_band(inter_kappa)})"
    )

    final_path = _final_path(args.dir)
    if disagreements and not final_path.is_file():
        print()
        print(f"{len(disagreements)} row(s) to adjudicate — re-read the clause together,")
        print(f"then write the agreed label for each into {final_path}")
        print("with columns `sample_id,label`:")
        for i in disagreements:
            print(f"  sample_id {i:<4} A said {labels_a[i]:<9} B said {labels_b[i]}")
        return 0

    if final_path.is_file():
        try:
            adjudicated = _read_labels(final_path)
        except JudgeValidationError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        missing = [i for i in disagreements if i not in adjudicated]
        if missing:
            print(
                f"error: {final_path.name} is missing adjudicated labels for "
                f"sample_id {missing}",
                file=sys.stderr,
            )
            return 1
        final = [adjudicated.get(i, labels_a[i]) for i in ids]
    else:
        final = a  # no disagreements: the agreed labels are the adjudicated labels

    payload = judge.build_validation_payload(rows, a, b, final)
    versus = payload["judge_vs_human"]
    print()
    print(
        f"judge vs human:  {versus['percent_agreement']:.1%} agreement, "
        f"kappa = {_fmt(versus['kappa'])} ({versus['band']})"
    )
    ci = versus["kappa_ci"]
    if ci:
        print(f"                 95% CI [{ci['low']:+.3f}, {ci['high']:+.3f}]")
    print()
    print(payload["gate"]["interpretation"])

    if args.json:
        print()
        print(json.dumps(payload, indent=2, sort_keys=True))

    if args.dry_run:
        print()
        print("dry run — nothing written")
        return 0

    db.write_analyses(dsn, {"judge_validation": payload})
    print()
    print("wrote analysis_results: judge_validation")
    return 0


def _fmt(kappa: float | None) -> str:
    return "undefined" if kappa is None else f"{kappa:.3f}"


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(sample_main())
