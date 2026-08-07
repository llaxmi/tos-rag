/**
 * Pulls the JSON object out of a judge reply.
 *
 * All three judge parsers (`parseCragVerdict`, `parseStatements`,
 * `parseNliVerdicts`) ask for JSON and accept a text fallback, so the rule for
 * *which* brace run counts is stated once here rather than three times. The
 * greedy `[\s\S]*` deliberately spans from the first `{` to the last `}`, so a
 * reply that wraps its JSON in prose or a fenced code block still parses.
 *
 * Returns null when there is no object or it does not parse — the caller then
 * runs its own (correctly different) fallback. Shape validation stays with the
 * caller: an object that parses but carries the wrong keys must fall through
 * too, and only the caller knows which keys it needs.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
