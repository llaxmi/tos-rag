import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // *.live.test.ts loads a ~1.2GB ONNX model and/or calls a paid API. Those
    // are real checks worth having, but they are not hermetic and must not gate
    // `pnpm test`. Run them deliberately with `pnpm --filter backend test:live`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
