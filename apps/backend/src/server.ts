import { serve } from "@hono/node-server";
import "dotenv/config";
import { createApp } from "./app";
import { createDemoDeps } from "./deps/demo";
import { createLiveDeps } from "./deps/live";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  WINNING_CONFIG_ID,
} = process.env;

const live =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && CF_ACCOUNT_ID && CF_API_TOKEN;

const app = createApp(
  live
    ? createLiveDeps({
        SUPABASE_URL: SUPABASE_URL!,
        SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY!,
        CF_ACCOUNT_ID: CF_ACCOUNT_ID!,
        CF_API_TOKEN: CF_API_TOKEN!,
        WINNING_CONFIG_ID: WINNING_CONFIG_ID ?? "1",
      })
    : createDemoDeps(),
);

const port = Number(process.env.PORT ?? 3000);
console.log(
  `tos-rag backend on :${port} (${live ? "live" : "demo"} dependencies)`,
);

serve({ fetch: app.fetch, port });
