/**
 * Public types for the Drizzle adapter.
 *
 * The adapter does NOT import Drizzle's driver-specific types at the type
 * boundary — Drizzle has separate flavors (`drizzle-orm/node-postgres`,
 * `drizzle-orm/postgres-js`, `drizzle-orm/neon-serverless`, etc.), each
 * with a slightly different `execute()` return shape. We define the
 * minimal structural surface the adapter actually uses; any Drizzle
 * Postgres client satisfies it via duck typing.
 *
 * The `sql` template tag is imported from `drizzle-orm` at value level —
 * users install `drizzle-orm` as a peer, so it's always available.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal interface for any Drizzle Postgres client capable of executing
 * a raw SQL fragment. `execute()`'s return shape varies by driver — for
 * `drizzle-orm/node-postgres` it's `{ rows: T[] }` (pg's `QueryResult`),
 * for `drizzle-orm/postgres-js` it's `T[]` directly. Both are unwrapped
 * by the adapter internally.
 */
export type DrizzleExecutor = {
  execute<T = unknown>(query: any): Promise<T>;
};

/**
 * Minimal interface for a top-level Drizzle client (capable of opening a
 * transaction). Drizzle's `db.transaction(async (tx) => …)` calls back with
 * a scoped client that still exposes `execute()` — that's the `tx` we hand
 * on to the adapter's methods.
 */
export type DrizzleTransactionalClient = DrizzleExecutor & {
  transaction<R>(fn: (tx: any) => Promise<R>): Promise<R>;
};

/**
 * What `createDrizzleAdapter` accepts: either a top-level Drizzle client
 * (and we open our own transactions) or a Drizzle transaction context
 * (and we join the caller's transaction).
 */
export type DrizzleDb = DrizzleTransactionalClient | DrizzleExecutor;

export type DrizzleAdapterOptions = {
  /**
   * Postgres table that holds the transition rows. Defaults to
   * `stateledger_transitions`. Override if you've namespaced it (e.g. per
   * tenant schema, or to avoid a collision in a legacy database).
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
 * Example (for a Drizzle `payments` table with `id` primary key):
 * ```ts
 * subjectStateColumn: {
 *   model: "payments",         // Postgres table name
 *   where: { id: payment.id }, // identifying columns
 *   column: "state",           // column to update
 * }
 * ```
 */
export type DrizzleSubjectStateHint = {
  /** Postgres table name. */
  model: string;
  /** Columns to identify the row. */
  where: Record<string, string | number | boolean>;
  /** Column to write the new state into. Defaults to `state`. */
  column?: string;
};
