/**
 * The one place the Anthropic Messages API is called from.
 *
 * Both consumers — the Opus generator arm (`deps/live.ts`) and the LLM judge
 * (`adapters/judge.ts`) — issue the identical single-turn request, so the
 * API-version pin, the request shape, and the text-block extraction live here
 * rather than in two copies that have to be changed together.
 *
 * Raw fetch, no SDK. `fetchImpl` is injectable so callers can exercise their
 * own guards (the judge's truncation check) without a network call.
 */

export interface AnthropicReply {
  /** The concatenated text blocks, trimmed. */
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** `"max_tokens"` when the reply hit the cap — the judge treats that as a
   *  failed row rather than parsing a truncated JSON prefix. */
  stopReason: string | null;
}

export async function callAnthropic(opts: {
  apiKey: string;
  model: string;
  maxTokens: number;
  prompt: string;
  /** Prefix for the thrown error, so a failure names which call site it came
   *  from ("Anthropic API failed" vs "Judge API failed"). */
  errorLabel: string;
  fetchImpl?: typeof fetch;
}): Promise<AnthropicReply> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      // Opus 4.8 and Sonnet 5 both removed `temperature` (400 if sent).
      // Thinking is disabled for both callers: the paid generator answers
      // directly from context, which is the fair comparison to Llama (which
      // does no extended reasoning), and the judge is a short classification
      // whose small token budget adaptive thinking would consume outright.
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`${opts.errorLabel}: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  };
  return {
    text: json.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim(),
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    stopReason: json.stop_reason ?? null,
  };
}
