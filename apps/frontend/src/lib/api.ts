import type {
  AnalysisRow,
  AskResponse,
  DocFilter,
  PipelineConfig,
} from "@tos-rag/shared";

export type {
  AnalysisRow,
  AskResponse,
  DocFilter,
  Evidence,
  GeneratorModel,
  PipelineConfig,
} from "@tos-rag/shared";

export async function ask(
  question: string,
  docId: DocFilter,
  config?: PipelineConfig,
): Promise<AskResponse> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question,
      ...(docId ? { docId } : {}),
      ...(config
        ? {
            strategy: config.strategy,
            chunkSize: config.chunkSize,
            model: config.model,
          }
        : {}),
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // non-JSON error body — fall through to the generic message
    }
    throw new Error(
      detail ||
        `The service couldn't answer (HTTP ${res.status}). Check that the backend is running, then try again.`,
    );
  }
  return (await res.json()) as AskResponse;
}

/** Returns null when the experiment hasn't produced results yet. */
export async function getResults(): Promise<AnalysisRow[] | null> {
  const res = await fetch("/api/results");
  if (!res.ok) return null;
  const body = (await res.json()) as { results: AnalysisRow[] };
  return body.results.length > 0 ? body.results : null;
}
