/**
 * Public types for the TypeORM adapter.
 *
 * The adapter does NOT import TypeORM's own classes at the type boundary.
 * Two reasons:
 *
 * 1. A fresh checkout (or a consumer that installed only `@stateledger/core`)
 *    must still typecheck without `typeorm` present. TypeORM is a peer here,
 *    not a dependency.
 * 2. The declared peer range is `>=0.3` on purpose, because the 0.3.x
 *    installed base is enormous and 1.x is new. `DataSource` and
 *    `EntityManager` are nominally different classes across those lines
 *    (1.x renamed `EntityManager#connection` to `#dataSource` and kept the
 *    old name as a deprecated getter, for example), but the two members this
 *    adapter actually needs | `query(sql, params)` and `transaction(fn)` |
 *    are identical in both. Declaring the minimal structural surface means
 *    both lines satisfy it by duck typing and neither pins us to a version.
 *
 * Unlike the Drizzle adapter, nothing is imported from the peer at value
 * level either: this adapter uses no decorators, no entity classes and no
 * query builder, so it never needs a TypeORM runtime import. See the README
 * for why that also means it does not need `reflect-metadata`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal interface for anything that can run a raw parameterized SQL
 * statement: a `DataSource`, a `DataSource`'s global `EntityManager`, or the
 * transaction-scoped `EntityManager` TypeORM hands to a `transaction()`
 * callback. This is the adapter's `TxHandle`.
 *
 * For Postgres, `query()` resolves to the driver rows directly (an array of
 * row objects), NOT a `{ rows }` wrapper the way node-postgres does. One
 * exception the adapter has to account for internally: TypeORM's Postgres
 * query runner returns `[rows, rowCount]` for `UPDATE` and `DELETE`, so only
 * `SELECT` and `INSERT ... RETURNING` results can be read as a row list.
 */
export type TypeormExecutor = {
  query<T = any>(sql: string, parameters?: any[]): Promise<T>;
};

/**
 * An executor that can also open a transaction. Both `DataSource` and
 * `EntityManager` expose `transaction()`, and both call back with an
 * `EntityManager` bound to a single `QueryRunner`, which is what makes the
 * advisory lock safe (see `withTransaction` in `./adapter.ts`).
 */
export type TypeormTransactionalClient = TypeormExecutor & {
  transaction<R>(runInTransaction: (manager: any) => Promise<R>): Promise<R>;
};

/**
 * Structural stand-in for `DataSource`. `createQueryRunner` is the
 * discriminator the adapter uses at runtime: a `DataSource` has it, an
 * `EntityManager` does not. Checked against the installed 1.x typings, where
 * `EntityManager` only ever receives a runner (in its constructor) and never
 * creates one; 0.3 draws the same line.
 */
export type TypeormDataSourceLike = TypeormTransactionalClient & {
  createQueryRunner(...args: any[]): any;
};

/**
 * Structural stand-in for `EntityManager`.
 *
 * A transaction-scoped manager carries the `QueryRunner` it is pinned to;
 * the `DataSource`'s global manager has no `queryRunner` at all. The adapter
 * reads `queryRunner.isTransactionActive` to decide whether it has been
 * handed a live transaction to join or a manager it should open one on.
 */
export type TypeormEntityManagerLike = TypeormTransactionalClient & {
  readonly queryRunner?: { readonly isTransactionActive?: boolean } | undefined;
};

/**
 * What `createTypeormAdapter` accepts: either a `DataSource` (we open our
 * own transactions) or an `EntityManager` (we join the caller's transaction
 * when it already has one, which is the common case inside a NestJS service
 * that is already running in a transactional boundary).
 */
export type TypeormClient = TypeormDataSourceLike | TypeormEntityManagerLike;

export type TypeormAdapterOptions = {
  /**
   * Postgres table that holds the transition rows. Defaults to
   * `stateledger_transitions`. Override if you've namespaced it (e.g. per
   * tenant schema, or to avoid a collision in a legacy database).
   *
   * Interpolated into the SQL as a quoted identifier, never as a bound
   * parameter (Postgres does not accept parameters in that position), so the
   * value is validated against a strict identifier pattern first.
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
 * `model` is the Postgres TABLE name, not the entity class name. The adapter
 * writes raw SQL and has no access to TypeORM's entity metadata, so it
 * cannot resolve `Payment` to `payments` for you. If your entity uses a
 * custom `@Entity("...")` name or a naming strategy, pass the physical table
 * name as it exists in the database.
 *
 * Example (for a `payments` table with an `id` primary key):
 * ```ts
 * subjectStateColumn: {
 *   model: "payments",         // Postgres table name
 *   where: { id: payment.id }, // identifying columns
 *   column: "state",           // column to update
 * }
 * ```
 */
export type TypeormSubjectStateHint = {
  /** Postgres table name. */
  model: string;
  /** Columns to identify the row. */
  where: Record<string, string | number | boolean>;
  /** Column to write the new state into. Defaults to `state`. */
  column?: string;
};
