import { describe, expect, test } from "vitest";
import { parsePhase2Args } from "../src/scripts/args";

describe("run-phase2 arg parsing", () => {
  test("accepts no flags", () => {
    expect(parsePhase2Args([])).toEqual({ model: undefined, limit: undefined });
  });

  test("accepts --model in space-separated form", () => {
    expect(parsePhase2Args(["--model", "llama"])).toEqual({ model: "llama", limit: undefined });
  });

  test("accepts --model in --flag=value form", () => {
    expect(parsePhase2Args(["--model=opus"])).toEqual({ model: "opus", limit: undefined });
  });

  test("rejects an unknown --model value", () => {
    expect(() => parsePhase2Args(["--model", "bogus"])).toThrow(/--model must be one of/);
  });

  test("rejects an unknown --model=value value", () => {
    expect(() => parsePhase2Args(["--model=bogus"])).toThrow(/--model must be one of/);
  });

  test("rejects an empty --model= value rather than treating it as absent", () => {
    expect(() => parsePhase2Args(["--model="])).toThrow(/--model must be one of/);
  });

  test("accepts --limit in space-separated and --flag=value form", () => {
    expect(parsePhase2Args(["--limit", "2"])).toEqual({ model: undefined, limit: 2 });
    expect(parsePhase2Args(["--limit=3"])).toEqual({ model: undefined, limit: 3 });
  });

  test("rejects a non-numeric --limit", () => {
    expect(() => parsePhase2Args(["--limit", "abc"])).toThrow(/--limit must be a positive integer/);
  });

  test("rejects --limit 0", () => {
    expect(() => parsePhase2Args(["--limit", "0"])).toThrow(/--limit must be a positive integer/);
  });

  test("rejects a negative --limit", () => {
    expect(() => parsePhase2Args(["--limit", "-1"])).toThrow(/--limit must be a positive integer/);
  });

  test("rejects a non-integer --limit", () => {
    expect(() => parsePhase2Args(["--limit", "1.5"])).toThrow(/--limit must be a positive integer/);
  });

  test("rejects an empty --limit= rather than silently dropping the cap", () => {
    expect(() => parsePhase2Args(["--limit="])).toThrow(/--limit must be a positive integer/);
  });
});
