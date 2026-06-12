/**
 * Public data shapes for stateledger.
 *
 * These types are the "vocabulary" the whole library speaks. Adapters,
 * machines, and user code all flow these shapes — they're the contract,
 * keep them stable.
 */

/**
 * An identity that triggered a transition. Mapped 1:1 to the `actor_id` /
 * `actor_type` columns on a transition row.
 *
 * `type` is intentionally a free-form string so users can carry their own
 * taxonomy ("USER" / "SYSTEM" / "WEBHOOK" / "ADMIN_OVERRIDE" / etc.).
 * stateledger does not interpret it.
 */
export type Actor = {
  id: string;
  type: string;
};

/**
 * A persisted transition row, as returned by the adapter.
 *
 * Generic over `State` so callers that know their machine's state union can
 * narrow the strings. Adapters always return `string` for the type-erased
 * read paths.
 */
export type TransitionRow<State extends string = string> = {
  id: string;
  machine: string;
  subjectId: string;
  /** `null` only on the initial (bootstrap) transition. */
  fromState: State | null;
  toState: State;
  /** Monotonic per `(machine, subjectId)`, assigned by the library. */
  sortKey: number;
  /** Exactly one row per subject has `mostRecent = true`. */
  mostRecent: boolean;
  actorId: string | null;
  actorType: string | null;
  metadata: Record<string, unknown>;
  /** Snapshot of the definition version this row was written under. */
  machineVersion: number;
  createdAt: Date;
};

/**
 * Input shape for {@link Adapter.appendTransition}.
 *
 * No `id` or `createdAt` (the adapter assigns those). `sortKey` is calculated
 * by the library — adapter trusts the value.
 */
export type NewTransitionRow<State extends string = string> = Omit<
  TransitionRow<State>,
  "id" | "createdAt"
>;

/**
 * Opaque pointer the library hands to {@link Adapter.updateSubjectState} when
 * the user opted into the `subjectStateColumn` denormalization.
 *
 * Shape is intentionally `Record<string, unknown>` — the adapter knows what
 * it asked for (e.g. Prisma adapter expects `{ model, where, column }`).
 * Core stores and forwards it without inspection.
 */
export type SubjectStateHint = Record<string, unknown>;

/**
 * Context passed to a guard function before a transition runs.
 *
 * Guards are synchronous from the library's perspective — async guards are
 * supported but their failure modes (timeout, swallowed rejection) are the
 * caller's responsibility. Keep them fast and DB-free.
 */
export type GuardContext<Subject = unknown> = {
  subject: Subject;
  from: string;
  to: string;
  actor: Actor;
};

/**
 * Context passed to an `after:from->to` callback.
 *
 * `tx` is the adapter's transaction handle — the same one used for the
 * transition write. Anything the callback does on `tx` is part of the same
 * atomic unit; if the callback throws, the transition rolls back.
 */
export type CallbackContext<TxHandle = unknown, Subject = unknown> = {
  subject: Subject;
  from: string;
  to: string;
  actor: Actor;
  /** Adapter-specific transaction handle. Use it for DB writes only. */
  tx: TxHandle;
};
