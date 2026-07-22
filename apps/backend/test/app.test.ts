import { describe, expect, test } from "vitest";
import type { RetrievedChunk } from "@tos-rag/core";
import { createApp, type AppDeps } from "../src/app";

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
    const res = await app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How much notice before fee changes?" }),
    });
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
    const res = await app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What is the meaning of life?" }),
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.abstained).toBe(true);
  });

  test("rejects missing question with 400", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
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
    await app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "q", docId: "netflix-tou" }),
    });
    expect(seenFilter).toBe("netflix-tou");
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
