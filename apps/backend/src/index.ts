import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { supabase } from "./lib/supabase";

const app = new Hono();

app.get("/", (c) => {
  return c.json({
    success: true,
    message: "Backend running",
  });
});

// Test route
app.get("/test", async (c) => {
  const { data, error } = await supabase.from("documents").select("*");

  return c.json({
    data,
    error,
  });
});

serve({
  fetch: app.fetch,
  port: 3000,
});
