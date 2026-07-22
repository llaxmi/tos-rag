import { serve } from "@hono/node-server";
import "dotenv/config";
import { createEmbedder } from "./adapters";
import { createApp } from "./app";
import { createLiveDeps } from "./deps/live";

const {
  DATABASE_URL,
  ANTHROPIC_API_KEY,
  EMBEDDER,
  EMBEDDER_DTYPE,
  OLLAMA_URL,
  OLLAMA_MODEL,
} = process.env;

// The backend serves only the real pipeline now (the demo fallback is gone).
// Without a database there is nothing to retrieve from, so fail loudly at boot
// rather than serving empty results.
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required — the backend serves the real pipeline only. " +
      "Start the local Supabase stack and copy apps/backend/.env.example to .env.",
  );
}

// Loads the ONNX model once, at boot, rather than per request.
const embedder = await createEmbedder({ EMBEDDER, EMBEDDER_DTYPE });

const deps = createLiveDeps(
  {
    OLLAMA_URL: OLLAMA_URL ?? "http://localhost:11434",
    OLLAMA_MODEL: OLLAMA_MODEL ?? "llama3.1:8b",
    ANTHROPIC_API_KEY,
  },
  embedder,
);

const app = createApp(deps);

const port = Number(process.env.PORT ?? 3000);
console.log(`tos-rag backend on :${port} (live, embedder ${embedder.name})`);

serve({ fetch: app.fetch, port });
