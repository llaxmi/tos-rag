import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  buildRagPrompt,
  isAbstention,
  type RetrievedChunk,
  type Strategy,
} from "@tos-rag/core";

export interface GenerationResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface RetrieveOptions {
  docId?: string;
}

export interface AnalysisRow {
  analysis: string;
  payload: unknown;
}

/**
 * Injected dependencies (PRD §4): the app is environment-agnostic — the same
 * routes run under Node locally and as a Cloudflare Worker; only deps differ.
 */
export interface AppDeps {
  retrieve: (
    question: string,
    opts?: RetrieveOptions,
  ) => Promise<RetrievedChunk[]>;
  generate: (prompt: string) => Promise<GenerationResult>;
  getAnalysisResults: () => Promise<AnalysisRow[]>;
  winningConfig: { strategy: Strategy; chunkSize: number };
}

const AskSchema = z.object({
  question: z.string().min(1).max(2000),
  docId: z.enum(["github-tos", "netflix-tou"]).optional(),
});

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("/api/*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/ask", async (c) => {
    const parsed = AskSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "question is required" }, 400);
    }
    const { question, docId } = parsed.data;

    const t0 = Date.now();
    const evidence = await deps.retrieve(question, { docId });
    const retrievalMs = Date.now() - t0;

    const { answer, latencyMs, inputTokens, outputTokens } =
      await deps.generate(buildRagPrompt(question, evidence));

    return c.json({
      answer,
      abstained: isAbstention(answer),
      evidence,
      config: deps.winningConfig,
      timings: { retrievalMs, generationMs: latencyMs },
      tokens: { input: inputTokens, output: outputTokens },
    });
  });

  app.get("/api/results", async (c) => {
    const results = await deps.getAnalysisResults();
    return c.json({ results });
  });

  return app;
}
