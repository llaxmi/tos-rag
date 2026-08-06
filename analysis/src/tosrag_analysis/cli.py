"""`pnpm analyze` — compute the Phase-1 statistics and write `analysis_results`.

A side-effecting one-shot, like `ingest` and `run-phase1`, and deliberately not a turbo
task: a cached run that silently no-ops would be a footgun.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import db, phase1


def _summarise(payloads: dict[str, dict]) -> str:
    ranking = payloads.get("phase1_config_ranking")
    best_vs_rest = payloads.get("phase1_best_vs_rest")
    lines: list[str] = []

    if ranking:
        lines.append(f"winner: {ranking['winner']}  (rule: {ranking['selection_rule']})")
        lines.append("")
        lines.append(f"{'rank':>4}  {'config':<18}  {'truthfulness':>12}  {'95% CI':>18}")
        for entry in ranking["configs"]:
            metric = entry["metrics"][phase1.HEADLINE_METRIC]
            ci = metric["ci"]
            ci_text = f"[{ci['low']:+.3f}, {ci['high']:+.3f}]" if ci else "n/a"
            lines.append(
                f"{entry['rank']:>4}  {entry['config']:<18}  {metric['mean']:>12.3f}  {ci_text:>18}"
            )

    if best_vs_rest:
        lines.append("")
        lines.append(best_vs_rest["interpretation"])
        significant = [c for c in best_vs_rest["comparisons"] if c["significant"]]
        if significant:
            lines.append("separable from:")
            for comparison in significant:
                lines.append(
                    f"  {comparison['config']:<18} p_holm = {comparison['p_holm']:.4f}"
                )
        else:
            lines.append(
                "no comparison survives Holm correction — the top configs are not "
                "statistically separable at this sample size (see the spec, section 9)"
            )

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyze",
        description="Phase-1 inferential statistics for tos-rag (PRD 11).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="compute and print the payloads without writing to the database",
    )
    parser.add_argument(
        "--only",
        action="append",
        choices=list(phase1.ANALYSIS_KEYS),
        help="write only this analysis key (repeatable); all keys by default",
    )
    parser.add_argument("--database-url", default=None, help="override DATABASE_URL")
    parser.add_argument("--json", action="store_true", help="print full payloads as JSON")
    args = parser.parse_args(argv)

    try:
        dsn = db.resolve_dsn(args.database_url)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        rows = db.load_phase1_rows(dsn)
    except Exception as exc:
        print(f"error: could not read Phase-1 rows: {exc}", file=sys.stderr)
        return 2

    print(f"loaded {len(rows)} Phase-1 rows")

    try:
        payloads = phase1.build_all(rows)
    except phase1.ShapeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.only:
        payloads = {key: payloads[key] for key in args.only}

    if args.json:
        print(json.dumps(payloads, indent=2, sort_keys=True))
    else:
        print()
        print(_summarise(payloads))

    if args.dry_run:
        print()
        print(f"dry run — nothing written ({', '.join(payloads)})")
        return 0

    db.write_analyses(dsn, payloads)
    print()
    print("wrote analysis_results:")
    for key, computed_at in db.count_analyses(dsn):
        print(f"  {key:<26} {computed_at}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
