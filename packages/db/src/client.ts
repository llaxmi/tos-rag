import { PrismaClient } from "@prisma/client";

/**
 * Process-wide Prisma singleton. The backend loads DATABASE_URL via its own
 * `dotenv/config`; scripts (seed, ingest) rely on the same env. One client per
 * process avoids exhausting the local Postgres connection limit under tsx watch.
 */
declare global {
  // eslint-disable-next-line no-var
  var __tosRagPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__tosRagPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__tosRagPrisma = prisma;
}
