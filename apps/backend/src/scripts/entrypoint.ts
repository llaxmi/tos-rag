/**
 * The tail every one-shot script ends with: run `main`, report a failure, set a
 * non-zero exit code, and hand the Prisma connection back.
 *
 * It was written out at the bottom of five scripts, which is how the Prisma
 * disconnect came to be present in two of them and absent from the rest. Kept
 * separate from `./shared` because that module wires the phase-runner deps
 * (embedder, judge) that these scripts do not all need.
 */
import { pathToFileURL } from "node:url";
import { prisma } from "@tos-rag/db";

/** True when this module's importer was run directly, rather than imported by a
 *  test. The scripts whose `main` is exercised in tests guard on this. */
export function isEntrypoint(moduleUrl: string): boolean {
  return moduleUrl === pathToFileURL(process.argv[1] ?? "").href;
}

export function runScript(
  main: () => Promise<void>,
  opts: {
    /** Release the Prisma pool so the process can exit on its own. */
    disconnect?: boolean;
    /** Print the whole error rather than just its message. The scripts that
     *  mutate stored evals use this: a stack is worth more than a tidy line
     *  when a write has half-completed. */
    verbose?: boolean;
  } = {},
): void {
  main()
    .catch((err: unknown) => {
      if (opts.verbose || !(err instanceof Error)) console.error(err);
      else console.error(`\n✗ ${err.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      if (opts.disconnect) void prisma.$disconnect();
    });
}
