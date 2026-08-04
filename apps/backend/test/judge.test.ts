import { describe, expect, test } from "vitest";
import { createJudge } from "../src/adapters/judge";
import { okFetch } from "./helpers";

describe("createJudge", () => {
  test("returns the joined text blocks on a normal reply", async () => {
    const judge = createJudge(
      { ANTHROPIC_API_KEY: "key" },
      512,
      okFetch({
        content: [{ type: "text", text: '{"verdicts": ["supported"]}' }],
        stop_reason: "end_turn",
      }),
    );
    await expect(judge.complete("PROMPT")).resolves.toBe('{"verdicts": ["supported"]}');
  });

  test("throws rather than returning a truncated reply when stop_reason is max_tokens", async () => {
    // A decomposition that hits the token cap comes back as a JSON prefix with
    // no closing brace. `parseStatements`/`parseNliVerdicts` would otherwise
    // read garbage from it (their line fallback returns the truncated JSON's
    // own lines) and a plausible-looking score would get written with no error
    // anywhere. The adapter must catch this before it ever reaches the parser.
    const judge = createJudge(
      { ANTHROPIC_API_KEY: "key" },
      2048,
      okFetch({
        content: [{ type: "text", text: '{"verdicts": ["supported", "unsup' }],
        stop_reason: "max_tokens",
      }),
    );
    await expect(judge.complete("PROMPT")).rejects.toThrow(/max_tokens/);
    await expect(judge.complete("PROMPT")).rejects.toThrow(/2048/);
  });

  test("passes the fetch call through with the configured maxTokens", async () => {
    let seenBody: any;
    const judge = createJudge(
      { ANTHROPIC_API_KEY: "key" },
      2048,
      okFetch(
        { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
        (_url, init) => {
          seenBody = JSON.parse(init.body as string);
        },
      ),
    );
    await judge.complete("PROMPT");
    expect(seenBody).toMatchObject({ max_tokens: 2048 });
  });

  test("throws when ANTHROPIC_API_KEY is missing, without calling fetch", async () => {
    const judge = createJudge({}, 512, okFetch({}));
    await expect(judge.complete("PROMPT")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
