import type { QuestionRecord } from "@tos-rag/core";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";

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
