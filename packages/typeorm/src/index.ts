// @stateledger/typeorm | TypeORM adapter for stateledger
//
// Wraps a TypeORM `DataSource` (or a transaction-scoped `EntityManager`, the
// common case inside a NestJS service that is already in a transactional
// boundary) so stateledger can read and write its transitions table via
// `manager.query(sql, params)`. Works across the 0.3.x and 1.x lines of
// TypeORM: the adapter is structurally typed on the two members both expose.
//
// Postgres-only | the advisory-lock and partial-unique patterns the library
// depends on are Postgres-specific.

export { createTypeormAdapter } from "./adapter.js";
export type {
  TypeormAdapterOptions,
  TypeormClient,
  TypeormDataSourceLike,
  TypeormEntityManagerLike,
  TypeormExecutor,
  TypeormSubjectStateHint,
  TypeormTransactionalClient,
} from "./types.js";
export { STATELEDGER_SCHEMA_SQL, STATELEDGER_SCHEMA_STATEMENTS } from "./schema-sql.js";
