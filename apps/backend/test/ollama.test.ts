import { describe, expect, test } from "vitest";
import { generateOllama } from "../src/deps/ollama";
import { okFetch } from "./helpers";

describe("generateOllama", () => {
  test("posts to /api/generate with frozen options and maps the response", async () => {
    let seenUrl = "";
    let seenBody: any;
    const fetchImpl = okFetch(
      { response: "  At least 30 days notice.  ", prompt_eval_count: 210, eval_count: 12 },
      (url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(init.body as string);
      },
    );

    const result = await generateOllama(
      { url: "http://localhost:11434", model: "llama3.1:8b" },
      "PROMPT",
      fetchImpl,
    );

    expect(seenUrl).toBe("http://localhost:11434/api/generate");
    expect(seenBody).toMatchObject({
      model: "llama3.1:8b",
      prompt: "PROMPT",
      stream: false,
      options: { temperature: 0, seed: 42, num_predict: 1024 },
    });
    expect(result.answer).toBe("At least 30 days notice."); // trimmed
    expect(result.inputTokens).toBe(210);
    expect(result.outputTokens).toBe(12);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("defaults token counts to 0 when Ollama omits them", async () => {
    const result = await generateOllama(
      { url: "http://x", model: "m" },
      "P",
      okFetch({ response: "ok" }),
    );
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test("throws a helpful error naming the url and model on non-OK", async () => {
    const badFetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    } as Response)) as unknown as typeof fetch;

    await expect(
      generateOllama({ url: "http://localhost:11434", model: "llama3.1:8b" }, "P", badFetch),
    ).rejects.toThrow(/Ollama.*llama3\.1:8b.*http:\/\/localhost:11434/s);
  });
});
