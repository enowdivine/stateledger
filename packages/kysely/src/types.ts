/**
 * Public types for the Kysely adapter.
 *
 * The adapter does NOT import Kysely's own types at the type boundary, for
 * the same two reasons the Drizzle adapter gives:
 *
 * 1. A fresh checkout has to typecheck before the peer is installed. `kysely`
 *    is a peer dependency, so naming `Kysely` or `Transaction` in the public
 *    surface would leave our emitted `.d.ts` unresolvable for anyone who has
 *    not installed it yet.
 * 2. `Kysely<DB>` is generic over the user's entire database interface, and
 *    `Transaction<DB>` extends that class. Threading `DB` through
 *    `createKyselyAdapter` would force every caller to annotate their schema
 *    type at the adapter boundary for zero benefit: this adapter speaks
 *    nothing but raw SQL against one fixed table, so it never consults `DB`
 *    and cannot type-check anything with it. Staying structural keeps the
 *    handle type a plain `Adapter<KyselyExecutor>`, with no generics leaking
 *    into machine definitions or callback contexts.
 *
 * The `sql` template tag is imported from `kysely` at value level in
 * `adapter.ts`. Users install `kysely` as a peer, so it is always there at
 * runtime; only the type surface stays driver-agnostic.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal surface the adapter needs in order to run a raw SQL fragment.
 *
 * Kysely runs a fragment as `` sql`...`.execute(provider) ``, and `provider`
 * only has to expose `getExecutor()`. Both `Kysely` and `Transaction` satisfy
 * that, which is why this one type covers the root client and the transaction
 * handle alike | there is no separate "tx" shape to model the way other query
 * builders need.
 *
 * Kysely marks `getExecutor()` `@internal` in its docblock while still
 * shipping it in the published typings. `` sql`...`.execute(db) `` is the
 * documented way to run raw SQL and this is the hook it consumes, so there is
 * no public alternative to name here. The return type is `any` because the
 * real one (`QueryExecutor`) is Kysely's own type and naming it would drag the
 * peer back into our public surface; we never call anything on the value, we
 * only hand the client back to Kysely.
 */
export type KyselyExecutor = {
  getExecutor(): any;
};

/**
 * What `db.transaction()` returns: a builder that has begun nothing yet.
 *
 * Kysely splits opening a transaction into two steps so isolation level and
 * access mode can be configured in between. Nothing happens until
 * `.execute(cb)` is called.
 */
export type KyselyTransactionBuilder = {
  execute<R>(callback: (trx: any) => Promise<R>): Promise<R>;
};

/**
 * Minimal surface of a Kysely client that can open a transaction.
 *
 * `isTransaction` is part of this type because it is the only reliable way to
 * tell a root client from a transaction: a Kysely `Transaction` extends
 * `Kysely`, so it carries a `transaction()` method too (one declared to return
 * `never`, which throws when called). See `withTransaction` in `adapter.ts`.
 */
export type KyselyTransactionalClient = KyselyExecutor & {
  transaction(): KyselyTransactionBuilder;
  readonly isTransaction: boolean;
};

/**
 * What `createKyselyAdapter` accepts: either a top-level `Kysely` instance
 * (and we open our own transactions) or a `Transaction` the caller already
 * opened higher up the stack (and we join it).
 */
export type KyselyDb = KyselyTransactionalClient | KyselyExecutor;

export type KyselyAdapterOptions = {
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
 * Names here are physical Postgres identifiers, not keys of your Kysely
 * `Database` interface. If your client runs `CamelCasePlugin`, write them the
 * way they exist in the database (`payment_attempts`, not `paymentAttempts`).
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
export type KyselySubjectStateHint = {
  /** Postgres table name. */
  model: string;
  /** Columns to identify the row. */
  where: Record<string, string | number | boolean>;
  /** Column to write the new state into. Defaults to `state`. */
  column?: string;
};
