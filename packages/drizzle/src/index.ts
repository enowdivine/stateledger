// @stateledger/drizzle — Drizzle adapter for stateledger
//
// Wraps a Drizzle Postgres client (any flavor: node-postgres, postgres.js,
// neon-serverless, vercel-postgres) so stateledger can read and write its
// transitions table via `db.execute(sql`` `` )`. Postgres-only — the
// advisory-lock and partial-unique patterns the library depends on are
// Postgres-specific.

export { createDrizzleAdapter } from "./adapter.js";
export type {
  DrizzleAdapterOptions,
  DrizzleDb,
  DrizzleExecutor,
  DrizzleSubjectStateHint,
  DrizzleTransactionalClient,
} from "./types.js";
export { STATELEDGER_SCHEMA_SQL, STATELEDGER_SCHEMA_STATEMENTS } from "./schema-sql.js";
