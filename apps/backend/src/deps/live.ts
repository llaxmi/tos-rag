import { createClient } from "@supabase/supabase-js";
import type { RetrievedChunk } from "@tos-rag/core";
import { GENERATION_MAX_TOKENS, GENERATION_SEED, MODEL_IDS, RETRIEVAL_K } from "@tos-rag/core";
import type { AppDeps } from "../app";

export interface LiveEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  WINNING_CONFIG_ID: string;
}

/**
 * Live dependencies (PRD §4/§8): pgvector exact-scan retrieval via the
 * match_chunks RPC and Workers AI REST for embedding + generation. The same
 * logic runs in the Worker via the env.AI binding.
 */
export function createLiveDeps(env: LiveEnv): AppDeps {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const aiUrl = (model: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;

  async function runAi<T>(model: string, payload: unknown): Promise<T> {
    const res = await fetch(aiUrl(model), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Workers AI ${model} failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { result: T };
    return json.result;
  }

  return {
    retrieve: async (question, opts) => {
      const { data: embedding } = await runAi<{ data: number[][] }>(
        MODEL_IDS.embedder,
        { text: [question] },
      );
      const { data, error } = await supabase.rpc("match_chunks", {
        p_config_id: Number(env.WINNING_CONFIG_ID),
        p_query: embedding[0],
        p_k: RETRIEVAL_K,
      });
      if (error) throw new Error(`match_chunks failed: ${error.message}`);
      const rows = (data ?? []) as Array<{
        doc_id: string;
        char_start: number;
        char_end: number;
        text: string;
        score: number;
      }>;
      return rows
        .filter((r) => !opts?.docId || r.doc_id === opts.docId)
        .map(
          (r): RetrievedChunk => ({
            docId: r.doc_id,
            charStart: r.char_start,
            charEnd: r.char_end,
            text: r.text,
            score: r.score,
          }),
        );
    },

    generate: async (prompt) => {
      const t0 = Date.now();
      const result = await runAi<{
        response: string;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>(MODEL_IDS.llama, {
        prompt,
        temperature: 0,
        seed: GENERATION_SEED,
        max_tokens: GENERATION_MAX_TOKENS,
      });
      return {
        answer: result.response.trim(),
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - t0,
      };
    },

    getAnalysisResults: async () => {
      const { data, error } = await supabase
        .from("analysis_results")
        .select("analysis, payload");
      if (error) throw new Error(`analysis_results failed: ${error.message}`);
      return data ?? [];
    },

    winningConfig: { strategy: "sentence", chunkSize: 256 },
  };
}
