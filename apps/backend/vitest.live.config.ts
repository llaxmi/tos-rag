import { defineConfig } from "vitest/config";

/** Only the non-hermetic checks. See vitest.config.ts for why they are split. */
export default defineConfig({
  test: {
    include: ["**/*.live.test.ts"],
    exclude: ["**/node_modules/**"],
    // Model load plus a forward pass over real chunks.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
