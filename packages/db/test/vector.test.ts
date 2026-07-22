import { describe, expect, it } from "vitest";
import { toVectorLiteral } from "../src/vector";

describe("toVectorLiteral", () => {
  it("formats a vector as a bracketed comma list with no spaces", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });

  it("handles an empty vector", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });

  it("passes small magnitudes through in whatever form Number#toString yields", () => {
    // pgvector accepts scientific notation, so `[1e-7]` is a valid literal.
    expect(toVectorLiteral([0.0000001])).toBe("[1e-7]");
  });
});
