// @stateledger/prisma — Prisma adapter for stateledger
//
// Wraps a `PrismaClient` (or a `Prisma.TransactionClient` when joining an
// outer transaction) so stateledger can read and write its transitions
// table via raw SQL. Postgres-only — the advisory-lock and partial-unique
// patterns the library depends on are Postgres-specific.

export { createPrismaAdapter } from "./adapter.js";
export type {
  PrismaAdapterOptions,
  PrismaSubjectStateHint,
  PrismaTx,
} from "./types.js";
export { STATELEDGER_SCHEMA_SQL, STATELEDGER_SCHEMA_STATEMENTS } from "./schema-sql.js";
