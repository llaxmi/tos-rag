"""`pnpm analyze` — compute the Phase-1 statistics and write `analysis_results`.

A side-effecting one-shot, like `ingest` and `run-phase1`, and deliberately not a turbo
task: a cached run that silently no-ops would be a footgun.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import db, phase1, phase2
from .grid import ShapeError


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


def _summarise_phase2(payload: dict) -> str:
    treatment = payload["models"]["treatment"]
    baseline = payload["models"]["baseline"]
    # Wide enough to print either model id in full: "claude-opus-4-8" is 15 characters,
    # longer than the fixed 16-wide column this used to share with a [:14] truncation,
    # which silently printed the non-existent id "claude-opus-4-".
    model_width = max(len(treatment), len(baseline)) + 2
    lines: list[str] = [
        f"Phase 2: {payload['comparison']}  (n = {payload['n_questions']} questions)",
        "",
        f"{'metric':<14}{treatment:>{model_width}}{baseline:>{model_width}}"
        f"{'p_raw':>9}{'p_holm':>9}{'pairs':>7}",
    ]

    def number(value, spec: str) -> str:
        return "n/a" if value is None else format(value, spec)

    for entry in payload["paired"]["metrics"]:
        lines.append(
            f"{entry['metric']:<14}"
            f"{number(entry['means'][treatment], f'>{model_width}.4f')}"
            f"{number(entry['means'][baseline], f'>{model_width}.4f')}"
            f"{number(entry['p_raw'], '>9.4f')}"
            f"{number(entry['p_holm'], '>9.4f')}"
            f"{entry['n_pairs_used']:>7}"
        )

    lines.append(
        "means are over complete pairs only (see `pairs`); arm-level means over all "
        "non-NULL runs are in the stored payload under `arms`"
    )

    wins = payload["win_counts"]
    lines += [
        "",
        payload["paired"]["interpretation"],
        f"per-question wins on {wins['metric']}: "
        f"{treatment} {wins['wins'][treatment]}, "
        f"{baseline} {wins['wins'][baseline]}, ties {wins['ties']}",
        f"retrieval identical across arms: {payload['retrieval']['identical']}",
    ]

    for model, entry in sorted(payload["abstention"]["models"].items()):
        lines.append(
            f"abstention {model:<16} recall {number(entry['recall'], '.3f')}  "
            f"precision {number(entry['precision'], '.3f')}  "
            f"(abstained {entry['n_abstained']} of {entry['n_unanswerable']} unanswerable)"
        )

    for subset in payload["subsets"]:
        subset_wins = subset["win_counts"]
        lines.append(
            f"subset {subset['label']:<16} n = {subset['n_questions']:<3} "
            f"{treatment} {number(subset['means'][treatment]['mean'], '.3f')} vs "
            f"{baseline} {number(subset['means'][baseline]['mean'], '.3f')}  "
            f"(wins {subset_wins['wins'][treatment]}/{subset_wins['wins'][baseline]}, "
            f"ties {subset_wins['ties']}; descriptive only)"
        )

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyze",
        description="Phase-1 and Phase-2 inferential statistics for tos-rag (PRD 11).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="compute and print the payloads without writing to the database",
    )
    parser.add_argument(
        "--only",
        action="append",
        choices=list(phase1.ANALYSIS_KEYS) + list(phase2.ANALYSIS_KEYS),
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

    selected = set(args.only) if args.only else set(phase1.ANALYSIS_KEYS) | set(phase2.ANALYSIS_KEYS)
    payloads: dict[str, dict] = {}

    # Load only the rows the selection needs. Phase 1's build runs 14 permutation tests
    # and is the slow half, so `--only phase2_paired` should not pay for it. An
    # incomplete phase not blocking the analysis of a phase that is complete only holds
    # under an explicit `--only`: on the default all-keys run, a Phase-1 ShapeError below
    # still returns 1 before Phase 2 is ever computed.
    # One table, one loop: the two phases load and build identically, and keeping
    # them as copy-pasted blocks is what let their error handling drift apart.
    phases = (
        ("Phase-1", phase1.ANALYSIS_KEYS, db.load_phase1_rows, phase1.build_all),
        ("Phase-2", phase2.ANALYSIS_KEYS, db.load_phase2_rows, phase2.build_all),
    )
    for label, keys, load_rows, build_all in phases:
        if not (selected & set(keys)):
            continue
        try:
            rows = load_rows(dsn)
        except ShapeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"error: could not read {label} rows: {exc}", file=sys.stderr)
            return 2
        print(f"loaded {len(rows)} {label} rows")
        try:
            built = build_all(rows)
        except ShapeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        payloads.update({k: v for k, v in built.items() if k in selected})

    if args.json:
        print(json.dumps(payloads, indent=2, sort_keys=True))
    else:
        print()
        phase1_summary = _summarise(payloads)
        summaries = [phase1_summary] if phase1_summary else []
        if "phase2_paired" in payloads:
            summaries.append(_summarise_phase2(payloads["phase2_paired"]))
        print("\n\n".join(summaries))

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
