/** Shared fakes for the backend tests, like `packages/core/test/helpers.ts`. */

/**
 * A `fetch` stand-in that always succeeds with `body`, optionally recording the
 * call. `generateOllama` and `createJudge` take their fetch as a parameter so
 * they can be tested with this — no network, no mocking framework.
 */
export function okFetch(
  body: unknown,
  capture?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}
