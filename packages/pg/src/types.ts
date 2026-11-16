/**
 * Public types for the raw-Postgres adapters.
 *
 * The adapter does NOT import `pg`'s or `postgres`'s own types at the type
 * boundary. Both are optional peers, so a fresh checkout that installed
 * only one of them (or neither, for a consumer that just wants the types)
 * must still typecheck. We therefore describe the minimal structural
 * surface the adapter actually touches, and any real driver object
 * satisfies it via duck typing.
 *
 * That structural surface has to mirror driver signatures that are
 * themselves `any`-heavy (`pg`'s overloaded `query()`, postgres.js's
 * `unsafe()`), so the types below use `any` in those exact positions. This
 * file is the only place in the package where `any` is allowed, hence the
 * scoped disable | everywhere else we take `unknown` and narrow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- node-postgres (`pg`) ----

/**
 * Anything in node-postgres that can run one parameterised statement:
 * a `Pool`, a `Client`, or a `PoolClient` checked out of a pool.
 *
 * This is also the transaction handle `createPgAdapter` hands to machine
 * callbacks, so whatever you do with it in an `after:` hook runs on the
 * same connection | and therefore inside the same transaction | as the
 * transition write.
 */
export type NodePostgresQueryable = {
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
};

/**
 * A connection checked out of a pool. The only addition over
 * {@link NodePostgresQueryable} is `release()`, which returns the
 * connection to the pool (or destroys it, when handed an error).
 */
export type NodePostgresPoolClient = NodePostgresQueryable & {
  release(err?: any): void;
};

/**
 * A node-postgres `Pool`.
 *
 * `totalCount` is in here on purpose and not for show: `Pool` and `Client`
 * both expose `connect()`, so the presence of `connect` alone cannot tell
 * them apart. The pool counters can, and the adapter uses `totalCount` as
 * the discriminator (see `isPool` in `./adapter.ts`).
 */
export type NodePostgresPool = NodePostgresQueryable & {
  connect(): Promise<NodePostgresPoolClient>;
  readonly totalCount: number;
};

/**
 * What `createPgAdapter` accepts: either a `Pool` (the adapter opens and
 * commits its own transactions) or an already-checked-out `PoolClient` /
 * `Client` (the adapter runs on the caller's connection and never emits
 * BEGIN, COMMIT, ROLLBACK, or `release()`).
 */
export type NodePostgresClient = NodePostgresPool | NodePostgresQueryable;

// ---- postgres.js (`postgres`) ----

/**
 * Anything in postgres.js that can run one parameterised statement from a
 * string: the top-level `sql`, a `TransactionSql`, or a `ReservedSql`.
 *
 * We go through `unsafe()` rather than the tagged template because the
 * adapter builds its SQL as plain strings (it has to interpolate the table
 * identifier, which no tagged template can parameterise). "Unsafe" here
 * means "the query text is not built by the tag", not "unparameterised" |
 * every user value still travels as a bound parameter.
 *
 * This is also the transaction handle `createPostgresJsAdapter` hands to
 * machine callbacks. It is the real transaction `sql` at runtime, so if you
 * want the tagged-template API inside a callback, narrow it to postgres.js's
 * own `TransactionSql` type on your side.
 */
export type PostgresJsQueryable = {
  unsafe(query: string, parameters?: any[]): PromiseLike<unknown>;
};

/**
 * A postgres.js instance that can open a transaction.
 *
 * `begin` is typed loosely because postgres.js resolves it through its
 * `UnwrapPromiseArray` conditional (an array result has its elements
 * awaited), which does not survive assignment to a plainly generic
 * `Promise<R>`. The adapter narrows the result where it uses it.
 *
 * A `TransactionSql` satisfies this too, and that is the supported way to
 * join a transaction the caller already opened: postgres.js turns a nested
 * `begin` into a savepoint, which rolls back independently and commits with
 * the outer transaction.
 */
export type PostgresJsSql = PostgresJsQueryable & {
  begin(fn: (sql: any) => Promise<any>): Promise<any>;
};

// ---- shared options ----

export type PgAdapterOptions = {
  /**
   * Postgres table that holds the transition rows. Defaults to
   * `stateledger_transitions`. Override if you've namespaced it (e.g. per
   * tenant schema, or to avoid a collision in a legacy database).
   *
   * Must be a plain unquoted identifier: `/^[A-Za-z_][A-Za-z0-9_]*$/`, at
   * most 63 characters. It is interpolated into the SQL text (no driver can
   * parameterise an identifier), so anything else is rejected at
   * construction time rather than quietly concatenated. Schema-qualified
   * names like `app.transitions` are deliberately not accepted | set
   * `search_path` on the connection instead.
   */
  tableName?: string;

  /**
   * Locking strategy.
   * - `"pessimistic"` (default): `pg_advisory_xact_lock` per
   *   `(machine, subjectId)`. Concurrent writers wait their turn.
   * - `"optimistic"`: skip the advisory lock; rely on the partial unique
   *   index on `most_recent` to detect lost races. Caller must catch
   *   `OptimisticConcurrencyError` and retry.
   */
  locking?: "pessimistic" | "optimistic";
};

/**
 * Shape of the optional `subjectStateColumn` hint passed to
 * `updateSubjectState`.
 *
 * Example (for a `payments` table with an `id` primary key):
 * ```ts
 * subjectStateColumn: {
 *   model: "payments",         // Postgres table name
 *   where: { id: payment.id }, // identifying columns
 *   column: "state",           // column to update
 * }
 * ```
 *
 * `model`, `column`, and every key of `where` are identifiers and go
 * through the same validation as `tableName`. The `where` *values* are
 * bound parameters.
 */
export type PgSubjectStateHint = {
  /** Postgres table name. */
  model: string;
  /** Columns to identify the row. */
  where: Record<string, string | number | boolean>;
  /** Column to write the new state into. Defaults to `state`. */
  column?: string;
};
