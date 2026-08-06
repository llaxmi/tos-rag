import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  buildRagPrompt,
  CHUNK_SIZES,
  GENERATOR_MODELS,
  isAbstention,
  STRATEGIES,
  type GenerationResult,
  type GeneratorModel,
  type RetrievedChunk,
  type Strategy,
} from "@tos-rag/core";

// Generator types are owned by @tos-rag/core (PRD §8.6); re-exported here so
// existing importers (deps/live.ts) keep resolving them from the app module.
export type { GenerationResult, GeneratorModel } from "@tos-rag/core";

export interface RetrieveOptions {
  docId?: string;
  strategy?: Strategy;
  chunkSize?: number;
}

export interface AnalysisRow {
  analysis: string;
  payload: unknown;
}

/**
 * Injected dependencies (PRD §4): the app is environment-agnostic — routes
 * never construct a client or read `process.env` directly, only deps differ.
 * The backend runs as a Node process only (PRD §15).
 */
export interface AppDeps {
  retrieve: (
    question: string,
    opts?: RetrieveOptions,
  ) => Promise<RetrievedChunk[]>;
  generate: (
    prompt: string,
    model: GeneratorModel,
  ) => Promise<GenerationResult>;
  getAnalysisResults: () => Promise<AnalysisRow[]>;
  winningConfig: { strategy: Strategy; chunkSize: number };
}

const AskSchema = z.object({
  question: z.string().min(1).max(2000),
  docId: z.enum(["github-tos", "netflix-tou"]).optional(),
  strategy: z.enum(STRATEGIES).optional(),
  chunkSize: z
    .number()
    .refine((n) => (CHUNK_SIZES as readonly number[]).includes(n), {
      message: `chunkSize must be one of ${CHUNK_SIZES.join(", ")}`,
    })
    .optional(),
  model: z.enum(GENERATOR_MODELS).optional(),
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
    const { question, docId, strategy, chunkSize, model } = parsed.data;

    // The proposal's three experimental variables are selectable; anything
    // omitted falls back to the winning configuration and the open model.
    const config = {
      strategy: strategy ?? deps.winningConfig.strategy,
      chunkSize: chunkSize ?? deps.winningConfig.chunkSize,
    };
    const generator: GeneratorModel = model ?? "llama";

    try {
      const t0 = Date.now();
      const evidence = await deps.retrieve(question, { docId, ...config });
      const retrievalMs = Date.now() - t0;

      const { answer, latencyMs, inputTokens, outputTokens } =
        await deps.generate(buildRagPrompt(question, evidence), generator);

      return c.json({
        answer,
        abstained: isAbstention(answer),
        evidence,
        config,
        model: generator,
        timings: { retrievalMs, generationMs: latencyMs },
        tokens: { input: inputTokens, output: outputTokens },
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "pipeline failure" },
        503,
      );
    }
  });

  app.get("/api/results", async (c) => {
    const results = await deps.getAnalysisResults();
    return c.json({ results });
  });

  return app;
}
