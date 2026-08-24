/**
 * Post-`prisma db push` DDL that Prisma's schema language can't express:
 *
 *  - Partial unique index on `stateledger_transitions` — the hard
 *    correctness invariant `@stateledger/prisma` relies on.
 *  - Full `stateledger_outbox` table + its indexes — the payments example
 *    uses `@stateledger/outbox` to enqueue a receipt email in the same
 *    transaction as the capture. Ships as raw SQL from the outbox package
 *    so any adapter (Prisma, Drizzle, raw pg) can install it identically.
 *
 * Idempotent — every statement uses `IF NOT EXISTS`, so re-running is safe.
 */

import { PrismaClient } from "@prisma/client";
import { OUTBOX_SCHEMA_STATEMENTS } from "@stateledger/outbox";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "stateledger_transitions_one_most_recent"
      ON "stateledger_transitions" (machine, subject_id)
      WHERE most_recent = TRUE
  `);
  console.log("✓ partial unique index applied");

  // Prisma rejects multi-statement scripts to $executeRawUnsafe (each call
  // is a prepared statement), so we loop the array shape.
  for (const stmt of OUTBOX_SCHEMA_STATEMENTS) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log("✓ stateledger_outbox table + indexes applied");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
