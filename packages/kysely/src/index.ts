// @stateledger/kysely | Kysely adapter for stateledger
//
// Wraps a Kysely client so stateledger can read and write its transitions
// table through the `sql` template tag. Nothing here uses the typed query
// builder, so the transitions table does not have to appear in your
// `Database` interface. Postgres-only | the advisory-lock and
// partial-unique patterns the library depends on are Postgres-specific.

export { createKyselyAdapter } from "./adapter.js";
export type {
  KyselyAdapterOptions,
  KyselyDb,
  KyselyExecutor,
  KyselySubjectStateHint,
  KyselyTransactionalClient,
  KyselyTransactionBuilder,
} from "./types.js";
export { STATELEDGER_SCHEMA_SQL, STATELEDGER_SCHEMA_STATEMENTS } from "./schema-sql.js";
