import { describe, expect, test } from "vitest";
import type { RetrievedChunk } from "@tos-rag/core";
import {
  createApp,
  type AppDeps,
  type GeneratorModel,
  type RetrieveOptions,
} from "../src/app";

const EVIDENCE: RetrievedChunk[] = [
  {
    docId: "github-tos",
    charStart: 100,
    charEnd: 180,
    text: "We will give at least 30 days notice before changing fees.",
    score: 0.93,
  },
  {
    docId: "github-tos",
    charStart: 400,
    charEnd: 470,
    text: "Fees are due monthly.",
    score: 0.71,
  },
];

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    retrieve: async () => EVIDENCE,
    generate: async () => ({
      answer: "At least 30 days notice.",
      inputTokens: 200,
      outputTokens: 12,
      latencyMs: 350,
    }),
    getAnalysisResults: async () => [
      { analysis: "phase1_main", payload: { rows: [] } },
    ],
    winningConfig: { strategy: "sentence", chunkSize: 256 },
    ...overrides,
  };
}

function askRequest(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("GET /api/health", () => {
  test("reports ok", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("POST /api/ask", () => {
  test("returns answer with evidence chunks and winning config", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request(
      "/api/ask",
      askRequest({ question: "How much notice before fee changes?" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.answer).toBe("At least 30 days notice.");
    expect(body.abstained).toBe(false);
    expect(body.evidence).toHaveLength(2);
    expect(body.evidence[0]).toMatchObject({
      docId: "github-tos",
      charStart: 100,
      charEnd: 180,
      score: 0.93,
    });
    expect(body.config).toEqual({ strategy: "sentence", chunkSize: 256 });
    expect(body.model).toBe("llama");
  });

  test("flags abstentions", async () => {
    const app = createApp(
      fakeDeps({
        generate: async () => ({
          answer: "I don't know",
          inputTokens: 150,
          outputTokens: 4,
          latencyMs: 200,
        }),
      }),
    );
    const res = await app.request(
      "/api/ask",
      askRequest({ question: "What is the meaning of life?" }),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.abstained).toBe(true);
  });

  test("rejects missing question with 400", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/api/ask", askRequest({}));
    expect(res.status).toBe(400);
  });

  test("passes docFilter through to retrieval", async () => {
    let seenFilter: string | undefined;
    const app = createApp(
      fakeDeps({
        retrieve: async (_q, opts) => {
          seenFilter = opts?.docId;
          return EVIDENCE;
        },
      }),
    );
    await app.request(
      "/api/ask",
      askRequest({ question: "q", docId: "netflix-tou" }),
    );
    expect(seenFilter).toBe("netflix-tou");
  });

  test("passes selected strategy, chunk size, and model through the pipeline", async () => {
    let seenOpts: RetrieveOptions | undefined;
    let seenModel: GeneratorModel | undefined;
    const app = createApp(
      fakeDeps({
        retrieve: async (_q, opts) => {
          seenOpts = opts;
          return EVIDENCE;
        },
        generate: async (_prompt, model) => {
          seenModel = model;
          return {
            answer: "ok",
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          };
        },
      }),
    );
    const res = await app.request(
      "/api/ask",
      askRequest({
        question: "q",
        strategy: "semantic",
        chunkSize: 128,
        model: "opus",
      }),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(seenOpts).toMatchObject({ strategy: "semantic", chunkSize: 128 });
    expect(seenModel).toBe("opus");
    expect(body.config).toEqual({ strategy: "semantic", chunkSize: 128 });
    expect(body.model).toBe("opus");
  });

  test("defaults omitted variables to the winning config and Llama", async () => {
    let seenOpts: RetrieveOptions | undefined;
    let seenModel: GeneratorModel | undefined;
    const app = createApp(
      fakeDeps({
        retrieve: async (_q, opts) => {
          seenOpts = opts;
          return EVIDENCE;
        },
        generate: async (_prompt, model) => {
          seenModel = model;
          return {
            answer: "ok",
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          };
        },
      }),
    );
    await app.request("/api/ask", askRequest({ question: "q" }));
    expect(seenOpts).toMatchObject({ strategy: "sentence", chunkSize: 256 });
    expect(seenModel).toBe("llama");
  });

  test("rejects an off-grid chunk size with 400", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request(
      "/api/ask",
      askRequest({ question: "q", chunkSize: 300 }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects an unknown strategy with 400", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request(
      "/api/ask",
      askRequest({ question: "q", strategy: "overlapping" }),
    );
    expect(res.status).toBe(400);
  });

  test("surfaces pipeline failures as 503 with the reason", async () => {
    const app = createApp(
      fakeDeps({
        generate: async () => {
          throw new Error(
            "Claude Opus generator isn't configured — set ANTHROPIC_API_KEY, or switch back to Llama.",
          );
        },
      }),
    );
    const res = await app.request(
      "/api/ask",
      askRequest({ question: "q", model: "opus" }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("GET /api/results", () => {
  test("returns analysis results", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/api/results");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.results[0]).toMatchObject({ analysis: "phase1_main" });
  });
});
