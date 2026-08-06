/**
 * Argv parsing for the local scripts. Deliberately dependency-free — no DB, no
 * embedder, nothing that touches the network — so every script can import it
 * (including the ones documented as DB-free, like `ingest --dry-run` and
 * `build-questions`) and so the parsers are unit-testable without standing up
 * Postgres. `shared.ts` is the sibling module for everything that *does* need
 * live services.
 */
import { GENERATOR_MODELS, type GeneratorModel } from "@tos-rag/core";

/**
 * Reads a flag's value from argv, accepting both `--flag value` and
 * `--flag=value`. The `=` form used to be silently ignored (`indexOf(flag)`
 * only matches the space-separated form), which meant a typo like
 * `--doc=netflix-tou` left the flag undefined and the script ran against its
 * default instead — ingesting the wrong document, or sweeping every config,
 * with no error. Returns `undefined` only when the flag is truly absent, never
 * for an empty value, so `--flag=` is rejected by the caller's validation
 * rather than silently treated as "no filter".
 */
export function getFlag(argv: string[], flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * `--limit N`, the smoke-run cap on questions per config/arm. Validated rather
 * than coerced: `Number("abc")` is NaN and `Number("")` is 0, and both used to
 * slip through a bare `limitArg ? Number(limitArg) : undefined` — NaN reads as
 * falsy so the cap silently vanished and the full sweep started, and a
 * negative value made `slice(0, -1)` quietly drop the last question.
 */
export function parseLimitFlag(argv: string[]): number | undefined {
  const raw = getFlag(argv, "--limit");
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer (got "${raw}").`);
  }
  return limit;
}

/** `--model llama|opus`, the Phase-2 single-arm restriction. */
export function parseModelFlag(argv: string[]): GeneratorModel | undefined {
  const raw = getFlag(argv, "--model");
  if (raw === undefined) return undefined;
  const model = GENERATOR_MODELS.find((m) => m === raw);
  if (model === undefined) {
    throw new Error(`--model must be one of ${GENERATOR_MODELS.join(", ")} (got "${raw}").`);
  }
  return model;
}

export interface Phase2Args {
  model?: GeneratorModel;
  limit?: number;
}

/** Lives here, not in run-phase2.ts, so a test can reach it without importing
 * the runner's live-service chain (dotenv, Prisma, the embedder adapters). */
export function parsePhase2Args(argv: string[]): Phase2Args {
  return { model: parseModelFlag(argv), limit: parseLimitFlag(argv) };
}

/** The three deferred `evals` columns, by the flag name that selects each. */
export const ALL_METRICS = ["faithfulness", "cosine", "cost"] as const;
export type MetricName = (typeof ALL_METRICS)[number];

export interface BackfillArgs {
  apply: boolean;
  force: boolean;
  phase?: 1 | 2;
  metrics: MetricName[];
}

/**
 * `--apply | --force | --phase 1|2 | --metric faithfulness|cosine|cost`.
 *
 * Unknown arguments are rejected, not ignored: a typo like `--metirc` would
 * otherwise widen the scope back to every metric and spend money on rows nobody
 * asked for. Absent flags mean "everything", which is safe only because the
 * script does nothing without `--apply`.
 */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const valueFlags = new Set(["--phase", "--metric"]);
  const booleanFlags = new Set(["--apply", "--force"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const equalsAt = arg.indexOf("=");
    const name = equalsAt === -1 ? arg : arg.slice(0, equalsAt);

    if (booleanFlags.has(name)) {
      if (equalsAt !== -1) {
        throw new Error(`${name} does not take a value (got "${arg}").`);
      }
      continue;
    }
    if (!valueFlags.has(name)) {
      throw new Error(`Unknown argument "${arg}".`);
    }
    if (equalsAt !== -1) {
      if (arg.slice(equalsAt + 1).length === 0) {
        throw new Error(`${name} requires a value.`);
      }
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    i++;
  }

  const rawPhase = getFlag(argv, "--phase");
  let phase: 1 | 2 | undefined;
  if (rawPhase !== undefined) {
    if (rawPhase !== "1" && rawPhase !== "2") {
      throw new Error(`--phase must be 1 or 2 (got "${rawPhase}").`);
    }
    phase = rawPhase === "1" ? 1 : 2;
  }

  const rawMetric = getFlag(argv, "--metric");
  let metrics: MetricName[] = [...ALL_METRICS];
  if (rawMetric !== undefined) {
    const metric = ALL_METRICS.find((m) => m === rawMetric);
    if (metric === undefined) {
      throw new Error(`--metric must be one of ${ALL_METRICS.join(", ")} (got "${rawMetric}").`);
    }
    metrics = [metric];
  }

  return {
    apply: argv.includes("--apply"),
    force: argv.includes("--force"),
    phase,
    metrics,
  };
}
