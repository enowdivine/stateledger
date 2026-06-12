/**
 * Applies the partial unique index that Prisma's DSL can't express.
 *
 * Run after `prisma migrate dev` / `prisma db push`. Idempotent — uses
 * `IF NOT EXISTS` so re-running is safe.
 *
 * Without this index, `@stateledger/prisma` still functions in
 * pessimistic-lock mode (because advisory locks serialize writers), but
 * the partial unique constraint is the hard correctness invariant the
 * library leans on for optimistic mode and as a defense in depth.
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
