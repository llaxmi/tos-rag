import type { RetrievedChunk, Strategy } from "@tos-rag/core";
import { GENERATION_MAX_TOKENS, MODEL_IDS, PHASE1_WINNER, RETRIEVAL_K } from "@tos-rag/core";
import { matchChunks, prisma, resolveConfigId } from "@tos-rag/db";
import type { Embedder } from "../adapters/embedder";
import type { AppDeps, GenerationResult } from "../app";
import { generateOllama } from "./ollama";

export interface LiveEnv {
  OLLAMA_URL?: string;
  OLLAMA_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
}

/**
 * Applied here rather than at each call site so the server and the phase
 * runners cannot drift apart. The model tag defaults from `MODEL_IDS.llama` —
 * the same constant written to `runs.model` — so the label the report cites and
 * the model actually invoked come from one source.
 */
const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/**
 * Live dependencies (PRD §4/§8): pgvector exact-scan retrieval via the
 * match_chunks RPC, generation via a local Ollama server (Llama, PRD §15) or
 * the Anthropic Messages API (Opus). Configs are resolved against the
 * `configs` table.
 *
 * The embedder is injected rather than constructed here: it owns a loaded ONNX
 * model that must be created once at boot, not per request, and injecting it
 * keeps this module testable with a fake.
 */
export function createLiveDeps(env: LiveEnv, embedder: Embedder): AppDeps {
  // Memoizes the DB lookup: the config grid is fixed per process, so each
  // (strategy, size) id is resolved once and cached for the process lifetime.
  const configIds = new Map<string, number>();
  async function cachedConfigId(
    strategy: Strategy,
    chunkSize: number,
  ): Promise<number> {
    const key = `${strategy}:${chunkSize}`;
    const cached = configIds.get(key);
    if (cached !== undefined) return cached;
    const id = await resolveConfigId(strategy, chunkSize);
    configIds.set(key, id);
    return id;
  }

  async function generateOpus(prompt: string): Promise<GenerationResult> {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Claude Opus generator isn't configured — set ANTHROPIC_API_KEY, or switch back to Llama.",
      );
    }
    const t0 = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_IDS.opus,
        max_tokens: GENERATION_MAX_TOKENS,
        // Opus 4.8 removed `temperature` (400 if sent). Thinking disabled so the
        // paid arm answers directly from context — a fair comparison to the
        // open (Llama) generator, which does no extended reasoning.
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const answer = json.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return {
      answer,
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
      latencyMs: Date.now() - t0,
    };
  }

  return {
    retrieve: async (question, opts) => {
      // app.ts always fills strategy/chunkSize from winningConfig, so both are
      // present on every call and the config is resolved by identity.
      const configId = await cachedConfigId(
        opts?.strategy ?? PHASE1_WINNER.strategy,
        opts?.chunkSize ?? PHASE1_WINNER.chunkSize,
      );
      const vector = await embedder.embedQuery(question);
      const rows = await matchChunks(
        configId,
        vector,
        RETRIEVAL_K,
        // Filtered inside the scan, so a doc-scoped question still gets k rows.
        opts?.docId ?? null,
      );
      return rows.map(
        (r): RetrievedChunk => ({
          docId: r.doc_id,
          charStart: r.char_start,
          charEnd: r.char_end,
          text: r.text,
          score: r.score,
        }),
      );
    },

    generate: (prompt, model) =>
      model === "opus"
        ? generateOpus(prompt)
        : generateOllama(
            {
              url: env.OLLAMA_URL ?? OLLAMA_DEFAULT_URL,
              model: env.OLLAMA_MODEL ?? MODEL_IDS.llama,
            },
            prompt,
          ),

    getAnalysisResults: async () => {
      const rows = await prisma.analysis_results.findMany({
        select: { analysis: true, payload: true },
      });
      return rows;
    },

    winningConfig: PHASE1_WINNER,
  };
}
