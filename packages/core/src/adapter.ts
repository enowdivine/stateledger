/**
 * The Adapter contract.
 *
 * Every persistence backend (Prisma, Drizzle, TypeORM, raw SQL, in-memory)
 * implements this interface. The library's logic operates exclusively against
 * `Adapter<TxHandle>` — it never knows whether the underlying store is
 * Postgres, MySQL, or a `Map`.
 *
 * Adapter authors should run their adapter through
 * {@link ./contract-tests | runContractTests} to verify the implementation
 * honors the locking, ordering, and rollback semantics the rest of the
 * library depends on.
 */

import type { NewTransitionRow, SubjectStateHint, TransitionRow } from "./types.js";

export interface Adapter<TxHandle = unknown> {
  /**
   * Acquire the lock that serializes transitions on a single subject.
   *
   * - Pessimistic adapters (Postgres advisory lock, MySQL `GET_LOCK`) block
   *   until the lock is theirs.
   * - Optimistic adapters may make this a no-op and rely on the partial unique
   *   index on `most_recent` to detect lost races at write time.
   *
   * The lock is tied to the lifetime of `tx` — when the caller commits or
   * rolls back, the adapter must release it. No separate `releaseLock`.
   */
  acquireLock(tx: TxHandle, machine: string, subjectId: string): Promise<void>;

  /**
   * Read the most recent transition for a subject, or `null` if the subject
   * has never transitioned.
   *
   * Implementations MUST query `WHERE most_recent = true` — never order by
   * `sort_key DESC LIMIT 1` (slower at scale and inconsistent with the
   * partial unique index).
   */
  readCurrent(
    tx: TxHandle,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null>;

  /**
   * Insert a new transition row AND flip the previous `most_recent` row to
   * `false` in the same transaction.
   *
   * Returns the inserted row, including the adapter-assigned `id` and
   * `createdAt`.
   *
   * Must throw an `OptimisticConcurrencyError` if the partial-unique index
   * on `most_recent` rejects the insert (the optimistic lost-race signal).
   * Any other DB error must be wrapped in `AdapterError`.
   */
  appendTransition(tx: TxHandle, row: NewTransitionRow): Promise<TransitionRow>;

  /**
   * Optionally update a denormalized `state` column on the subject's own row.
   *
   * Only called when the user configured `subjectStateColumn` on the machine.
   * `hint` is adapter-specific opaque metadata the adapter knows how to use
   * (Prisma adapter expects `{ model, where, column }`).
   */
  updateSubjectState?(
    tx: TxHandle,
    hint: SubjectStateHint,
    newState: string,
  ): Promise<void>;

  /**
   * Read every transition for a subject, ordered by `sort_key` ascending
   * (oldest first).
   *
   * `tx` is optional — passing `null` means "read on a fresh connection
   * outside any transaction." Callers requesting strict read-after-write
   * consistency must pass the same `tx` they wrote in.
   */
  readHistory(
    tx: TxHandle | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]>;

  /**
   * Return the transition that was current at `at` — i.e. the most recent
   * row whose `createdAt <= at`. Returns `null` when no transition had
   * occurred yet at that moment (the subject didn't exist).
   *
   * Powers `Machine.stateAt(at)`. Implementations should run a single query:
   *   WHERE machine = ? AND subject_id = ? AND created_at <= ?
   *   ORDER BY sort_key DESC LIMIT 1
   *
   * `tx` follows the same convention as `readHistory` — `null` for a fresh
   * read outside any transaction.
   */
  readStateAt(
    tx: TxHandle | null,
    machine: string,
    subjectId: string,
    at: Date,
  ): Promise<TransitionRow | null>;

  /**
   * Run `fn` inside a transaction. The adapter opens one if `fn` is the
   * outermost call; if the caller already provided a transaction at the
   * machine level, this MUST join it rather than open a new one.
   *
   * If `fn` throws, the transaction is rolled back and the error is
   * re-thrown. If `fn` returns, the transaction commits and its return
   * value bubbles up.
   */
  withTransaction<R>(fn: (tx: TxHandle) => Promise<R>): Promise<R>;
}
