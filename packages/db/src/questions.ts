import type { QuestionRecord, Span } from "@tos-rag/core";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";

/** A seeded question, ready for the orchestrator (gold spans as `Span`s). */
export interface QuestionRow {
  id: string;
  docId: string;
  qtype: string;
  question: string;
  expectedAnswer: string;
  goldSpans: Span[];
  phase1: boolean;
}

/** Reads seeded questions (optionally only the phase-1 subset), id-ordered. */
export async function getQuestions(opts?: {
  phase1?: boolean;
}): Promise<QuestionRow[]> {
  const rows = await prisma.questions.findMany({
    where: opts?.phase1 === undefined ? {} : { phase1: opts.phase1 },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    qtype: r.qtype,
    question: r.question,
    expectedAnswer: r.expected_answer,
    goldSpans: (
      r.gold_spans as unknown as Array<{ char_start: number; char_end: number }>
    ).map((s) => ({ charStart: s.char_start, charEnd: s.char_end })),
    phase1: r.phase1,
  }));
}

/**
 * Idempotently upserts question rows by id (PRD §6, §9). Re-running seeds the
 * same rows — updated in place, never duplicated. `gold_spans` is stored in the
 * `Json` column verbatim. Wrapped in a transaction so a partial failure leaves
 * the table unchanged.
 */
export async function upsertQuestions(records: QuestionRecord[]): Promise<number> {
  await prisma.$transaction(
    records.map((r) => {
      const data = {
        doc_id: r.doc_id,
        qtype: r.qtype,
        question: r.question,
        expected_answer: r.expected_answer,
        gold_spans: r.gold_spans as unknown as Prisma.InputJsonValue,
        phase1: r.phase1,
      };
      return prisma.questions.upsert({
        where: { id: r.id },
        create: { id: r.id, ...data },
        update: data,
      });
    }),
  );
  return records.length;
}
