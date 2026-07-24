import { QuestionRecordSchema, type QuestionRecord } from "../schemas";

/**
 * Parses the generated `corpus/questions/<doc>.jsonl` (PRD §6) into validated
 * records. Pure and hermetic — the seed script's fragile part (schema
 * conformance) is testable without a database.
 *
 * Blank lines are ignored; the first malformed line throws with its 1-based
 * line number so a hand-edited file points at the exact problem.
 */
export function parseQuestionsJsonl(text: string): QuestionRecord[] {
  const records: QuestionRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      throw new Error(`Invalid JSON on line ${i + 1}: ${(e as Error).message}`);
    }

    const parsed = QuestionRecordSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Invalid question record on line ${i + 1}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    records.push(parsed.data);
  }
  return records;
}
