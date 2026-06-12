/**
 * Public types for the Prisma adapter.
 *
 * The adapter does NOT import from `@prisma/client` at type level — the
 * package only exposes its generated types AFTER the user runs
 * `prisma generate`, which means library code that imports them can't be
 * typechecked in a fresh checkout. Instead we declare the minimal
 * structural surface we actually call. A real `PrismaClient` (or
 * `Prisma.TransactionClient`) satisfies it via duck typing — the user
 * passes `prisma` and it just works.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal interface for any Prisma client capable of running raw SQL.
 * Satisfied by both `PrismaClient` and `Prisma.TransactionClient`.
 */
export type PrismaRawCalls = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<unknown>;
};

/**
 * Minimal interface for the top-level Prisma client (capable of opening a
 * transaction). The `fn` parameter is typed `any` so a user's
 * `PrismaClient`, whose `$transaction` callback receives a
 * `Prisma.TransactionClient` with many more members than our minimal
 * `PrismaRawCalls`, remains structurally assignable to this type.
 */
export type PrismaTransactionalClient = PrismaRawCalls & {
  $transaction<R>(fn: (tx: any) => Promise<R>, options?: any): Promise<R>;
};

/**
 * What `createPrismaAdapter` accepts: either a top-level Prisma client
 * (and we open our own transactions) or an already-open
 * `Prisma.TransactionClient` (and we join the caller's transaction).
 */
export type PrismaTx = PrismaTransactionalClient | PrismaRawCalls;

export type PrismaAdapterOptions = {
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
 * Example (for a Prisma `payment` model with `id` primary key):
 * ```ts
 * subjectStateColumn: {
 *   model: "payment",          // Postgres table name
 *   where: { id: payment.id }, // identifying columns
 *   column: "state",           // column to update
 * }
 * ```
 */
export type PrismaSubjectStateHint = {
  /** Postgres table name (NOT the Prisma model field name). */
  model: string;
  /** Columns to identify the row. */
  where: Record<string, string | number | boolean>;
  /** Column to write the new state into. Defaults to `state`. */
  column?: string;
};
