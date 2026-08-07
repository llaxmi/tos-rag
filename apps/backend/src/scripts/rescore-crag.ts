/**
 * Re-scores stored `evals.crag_score` under the amended CRAG decision order
 * (PRD §10.3, amended 2026-08-01) without re-generating or re-judging anything.
 *
 * Two defects made the old order punctuation-dependent: `isAbstention` ignored
 * trailing sentence punctuation while SQuAD's `normalizeAnswer` stripped it, and
 * abstention was checked before exact match. Together they meant "I don't know."
 * and "I don't know" took different branches — scoring +1 vs 0 on unanswerable
 * questions, and −1 vs 0 on answerable ones. See the 2026-08-01 entry in
 * `docs/report-notes.md` for the full write-up and the affected counts.
 *
 *   pnpm rescore-crag              # dry run: report what would change
 *   pnpm rescore-crag --apply      # write the corrected scores
 *
 * **Costs nothing and calls no model.** Only rows the *rules* decide are
 * touched; a row that the new order would still send to the judge keeps its
 * stored verdict, because neither the judge prompt nor the answer changed. That
 * is what makes this a pure re-scoring of collected data rather than a re-run.
 *
 * Unlike `ingest`/`analyze`, this rewrites already-collected experimental rows,
 * so it is dry-run by default and needs an explicit `--apply`.
 */
import "dotenv/config";
import { RULE_EXPLANATIONS, cragRuleVerdict } from "@tos-rag/core";
import { prisma } from "@tos-rag/db";
import { isEntrypoint, runScript } from "./entrypoint";

interface Change {
  runId: bigint;
  phase: number;
  model: string;
  questionId: string;
  qtype: string;
  from: number;
  to: number;
  explanation: string;
}

async function planRescore(): Promise<Change[]> {
  const rows = await prisma.runs.findMany({
    select: {
      id: true,
      phase: true,
      model: true,
      question_id: true,
      answer: true,
      evals: { select: { crag_score: true, judge_explanation: true } },
      questions: { select: { expected_answer: true, qtype: true } },
    },
    orderBy: { id: "asc" },
  });

  const changes: Change[] = [];
  for (const r of rows) {
    const stored = r.evals?.crag_score;
    if (stored === undefined || stored === null) continue;
    const verdict = cragRuleVerdict(r.answer, r.questions.expected_answer);
    if (verdict === null || verdict.score === stored) continue;
    // A row the rules now own may have been decided by the judge before. That
    // verdict is real evidence about how the judge behaves — keep the text
    // rather than flattening it, so the correction stays auditable.
    const wasJudged =
      r.evals?.judge_explanation !== RULE_EXPLANATIONS.abstained &&
      r.evals?.judge_explanation !== RULE_EXPLANATIONS.exactMatch;
    changes.push({
      runId: r.id,
      phase: r.phase,
      model: r.model,
      questionId: r.question_id,
      qtype: r.questions.qtype,
      from: stored,
      to: verdict.score,
      explanation: wasJudged
        ? `${verdict.explanation} (re-scored; prior judge verdict: ${r.evals?.judge_explanation ?? ""})`
        : verdict.explanation,
    });
  }
  return changes;
}

function summarize(changes: Change[]): void {
  const byBucket = new Map<string, number>();
  for (const c of changes) {
    const key = `phase ${c.phase} · ${c.qtype} · ${c.from} → ${c.to}`;
    byBucket.set(key, (byBucket.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...byBucket].sort()) {
    console.log(`  ${key.padEnd(42)} ${n}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const changes = await planRescore();

  console.log(
    `CRAG re-score under the amended decision order — ${changes.length} row(s) change.`,
  );
  if (changes.length > 0) summarize(changes);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write these scores.");
    return;
  }
  if (changes.length === 0) {
    console.log("Nothing to write.");
    return;
  }

  // One transaction: the corrected scores land together or not at all, so a
  // failure can never leave the table half-scored under two different rules.
  await prisma.$transaction(
    changes.map((c) =>
      prisma.evals.update({
        where: { run_id: c.runId },
        data: { crag_score: c.to, judge_explanation: c.explanation },
      }),
    ),
  );
  console.log(`\nApplied. ${changes.length} eval row(s) re-scored.`);
}

if (isEntrypoint(import.meta.url)) {
  runScript(main, { disconnect: true, verbose: true });
}
