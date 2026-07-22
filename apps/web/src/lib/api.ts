export interface Evidence {
  docId: string;
  charStart: number;
  charEnd: number;
  text: string;
  score: number;
}

export interface AskResponse {
  answer: string;
  abstained: boolean;
  evidence: Evidence[];
  config: { strategy: string; chunkSize: number };
  timings: { retrievalMs: number; generationMs: number };
  tokens: { input: number; output: number };
}

export type DocFilter = "github-tos" | "netflix-tou" | undefined;

export async function ask(
  question: string,
  docId: DocFilter,
): Promise<AskResponse> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(docId ? { question, docId } : { question }),
  });
  if (!res.ok) {
    throw new Error(`The service couldn't answer (HTTP ${res.status}). Check that the backend is running, then try again.`);
  }
  return (await res.json()) as AskResponse;
}

export interface AnalysisRow {
  analysis: string;
  payload: unknown;
}

/** Returns null when the experiment hasn't produced results yet. */
export async function getResults(): Promise<AnalysisRow[] | null> {
  const res = await fetch("/api/results");
  if (!res.ok) return null;
  const body = (await res.json()) as { results: AnalysisRow[] };
  return body.results.length > 0 ? body.results : null;
}
