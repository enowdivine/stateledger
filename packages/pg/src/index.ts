// @stateledger/pg | raw-Postgres adapters for stateledger
//
// For backends with no ORM at all: a `pg` pool or a postgres.js instance is
// all this needs. Two factories, because the two drivers handle
// transactions and query results differently enough that one would have to
// guess which it was holding:
//
//   createPgAdapter(pool)         // node-postgres (`pg`)
//   createPostgresJsAdapter(sql)  // postgres.js (`postgres`)
//
// Postgres-only | the advisory-lock and partial-unique patterns the library
// depends on are Postgres-specific.

export { createPgAdapter, createPostgresJsAdapter } from "./adapter.js";
export type {
  NodePostgresClient,
  NodePostgresPool,
  NodePostgresPoolClient,
  NodePostgresQueryable,
  PgAdapterOptions,
  PgSubjectStateHint,
  PostgresJsQueryable,
  PostgresJsSql,
} from "./types.js";
export { STATELEDGER_SCHEMA_SQL, STATELEDGER_SCHEMA_STATEMENTS } from "./schema-sql.js";
