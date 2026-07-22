/**
 * Seeds the 15 Phase 1 configs: 5 chunking strategies × 3 chunk sizes (PRD §7).
 * Idempotent — skipDuplicates makes re-running harmless. Ids are serial and
 * assigned in insert order; never hardcode them, always resolve by
 * (strategy, chunk_size). (Replaces retired supabase/migrations/0003_seed_configs.sql.)
 */
import { CHUNK_SIZES, STRATEGIES } from "@tos-rag/core";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const rows = STRATEGIES.flatMap((strategy) =>
    CHUNK_SIZES.map((chunk_size) => ({ strategy, chunk_size })),
  );
  const { count } = await prisma.configs.createMany({ data: rows, skipDuplicates: true });
  console.log(`seeded configs: ${count} inserted, ${rows.length} total intended`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
