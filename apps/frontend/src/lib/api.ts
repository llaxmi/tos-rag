import type {
  AnalysisRow,
  AskResponse,
  CanonicalDocument,
  DocFilter,
  PipelineConfig,
} from "@tos-rag/shared";

export type {
  AnalysisRow,
  AskResponse,
  CanonicalDocument,
  DocFilter,
  Evidence,
  GeneratorModel,
  PipelineConfig,
} from "@tos-rag/shared";

/** Prefers the backend's own reason for a failure — it names the actual cause
 *  (a validation message, the sha256-drift refusal) — and falls back to
 *  `fallback` only when the error body isn't JSON. */
async function failure(res: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    detail = ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    // non-JSON error body — fall through to the generic message
  }
  return new Error(detail || fallback);
}

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
    throw await failure(
      res,
      `The service couldn't answer (HTTP ${res.status}). Check that the backend is running, then try again.`,
    );
  }
  return (await res.json()) as AskResponse;
}

/**
 * Returns null when the experiment hasn't produced results yet, and *throws*
 * when the results couldn't be fetched at all. The two are different findings:
 * "nothing analysed yet" tells the reader to run `pnpm analyze`, while an
 * unreachable or erroring backend must not be reported as an empty database.
 */
export async function getResults(): Promise<AnalysisRow[] | null> {
  const res = await fetch("/api/results");
  if (!res.ok) {
    throw new Error(
      `The results service couldn't answer (HTTP ${res.status}). Check that the backend and its database are running.`,
    );
  }
  const body = (await res.json()) as { results: AnalysisRow[] };
  return body.results.length > 0 ? body.results : null;
}

/** Fetches a frozen canonical document. Throws with the backend's reason —
 *  including the sha256-drift refusal, which explains why the text can't be
 *  trusted to carry the recorded citation offsets. */
export async function getDocument(docId: string): Promise<CanonicalDocument> {
  const res = await fetch(`/api/document/${docId}`);
  if (!res.ok) {
    throw await failure(
      res,
      `Couldn't load the source document (HTTP ${res.status}). Check that the backend is running, then try again.`,
    );
  }
  return (await res.json()) as CanonicalDocument;
}
