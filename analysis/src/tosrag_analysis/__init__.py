"""Inferential statistics and judge validation for tos-rag (PRD 11, 10.3).

TypeScript deliberately computes no inferential statistics: `@stdlib/stats-wilcoxon`
silently falls back to a normal approximation in the presence of ties and zeros, which
is certain for a metric valued in {-1, 0, +1}. This package is where the signed-rank
tests, bootstrap intervals, and multiple-comparison correction live, alongside the
judge-validation sampling and Cohen's kappa.
"""

__all__ = ["cli", "db", "judge", "judge_cli", "phase1", "stats"]
