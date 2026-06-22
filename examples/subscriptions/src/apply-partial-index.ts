/**
 * Applies the partial unique index that Prisma's DSL can't express.
 * For this example it's **load-bearing**: we use optimistic concurrency,
 * and the partial unique index is the only thing stopping two racing
 * writers from both inserting a new `mostRecent = true` row for the
 * same subject. Without it, optimistic mode is unsafe.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "stateledger_transitions_one_most_recent"
      ON "stateledger_transitions" (machine, subject_id)
      WHERE most_recent = TRUE
  `);
  console.log("✓ partial unique index applied");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
