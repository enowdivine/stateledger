/**
 * Public types for @stateledger/outbox.
 *
 * The package targets Postgres and uses raw SQL via a duck-typed transaction
 * handle (`OutboxTx`) — the same structural approach as the Prisma adapter.
 * Any client capable of `$executeRawUnsafe` / `$queryRawUnsafe` satisfies
 * it: Prisma's `PrismaClient`, `Prisma.TransactionClient`, or a small shim
 * over a raw `pg` pool.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimum surface for the outbox client. Both Prisma clients (top-level or
 * transaction) satisfy this via structural typing — the user just passes
 * `prisma` (or the `tx` handed to their after-callback) and it works.
 *
 * The two methods intentionally mirror Prisma's raw-SQL escape hatches:
 *
 *   - `$queryRawUnsafe`  → SELECT ...        (materialized rows)
 *   - `$executeRawUnsafe` → INSERT/UPDATE/DDL (no rows returned)
 */
export type OutboxTx = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<unknown>;
};

/** Terminal + intermediate row states — mirrors the DB `CHECK` constraint. */
export type OutboxStatus = "pending" | "processing" | "delivered" | "failed";

/**
 * A row read back from the outbox table. Shape is the public read-model —
 * users should not depend on any column the type omits.
 */
export type OutboxRecord<Payload = Record<string, unknown>> = {
  id: string;
  kind: string;
  payload: Payload;
  region: string | null;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  availableAt: Date;
  claimedAt: Date | null;
  workerId: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
};

/**
 * Input to {@link enqueue}. `payload` is stored as JSONB — keep it small and
 * self-contained. `availableAt` lets you schedule delayed dispatch (e.g.
 * "send this reminder in 24 hours"); defaults to `NOW()`.
 */
export type EnqueueInput<Payload = Record<string, unknown>> = {
  kind: string;
  payload: Payload;
  region?: string | null;
  availableAt?: Date;
};

/**
 * A dispatcher for a single `kind`. Receives the deserialized payload and
 * metadata about the current attempt.
 *
 * - Throw to signal failure. The worker increments `attempts` and either
 *   reschedules (with backoff) or dead-letters based on `maxAttempts`.
 * - Return normally to signal success. The row is marked `delivered`.
 *
 * Handlers MUST be idempotent — outbox delivery is at-least-once. A crash
 * mid-dispatch may re-deliver the same row; your side effect (Stripe call,
 * email send, etc.) needs its own idempotency key on the receiver.
 */
export type OutboxHandler<Payload = Record<string, unknown>> = (
  payload: Payload,
  meta: {
    kind: string;
    region: string | null;
    attempts: number;
    /** The full record, for logging or custom introspection. */
    record: OutboxRecord<Payload>;
  },
) => Promise<void>;

/** Registry of handlers keyed by `kind`. */
export type HandlerRegistry = Record<string, OutboxHandler<any>>;

/** Config for {@link createWorker}. */
export type WorkerConfig = {
  /** Postgres client. Top-level, since the worker runs outside any user tx. */
  client: OutboxTx;

  /** Handlers to run per `kind`. Unknown kinds are dead-lettered immediately. */
  handlers: HandlerRegistry;

  /**
   * Only claim rows whose `region` matches this value. `undefined` (the
   * default) means "claim any row, including rows with a `NULL` region."
   * Combine multiple regions by running multiple workers or by omitting.
   */
  region?: string;

  /**
   * Unique-ish identifier for the worker instance, stored on the row when it
   * claims. Defaults to `${hostname}:${pid}:${short-uuid}`. Useful for
   * debugging "who's stuck on this row."
   */
  workerId?: string;

  /** Poll interval when the queue was empty on the last tick. Default 500ms. */
  pollIntervalMs?: number;

  /** Max attempts before a row is moved to `failed` (dead letter). Default 5. */
  maxAttempts?: number;

  /**
   * Backoff strategy for failed attempts. Receives the current attempt count
   * (1-based) and returns milliseconds to wait before the row becomes
   * eligible again. Default: exponential 1s, 2s, 4s, 8s, 16s, capped at 5 min.
   */
  backoffMs?: (attempt: number) => number;

  /**
   * Optional observer for internal events — dispatch success, failure,
   * reschedule, dead-letter. Non-throwing; called after the DB write.
   * Use for logging / metrics / alerting.
   */
  onEvent?: (event: WorkerEvent) => void;
};

/**
 * Lifecycle events the worker emits. Consumers may attach a logger,
 * metrics client, or Slack notifier here without needing to fork the
 * worker code.
 */
export type WorkerEvent =
  | { type: "claimed"; record: OutboxRecord }
  | { type: "delivered"; record: OutboxRecord; durationMs: number }
  | { type: "rescheduled"; record: OutboxRecord; error: unknown; nextAvailableAt: Date }
  | { type: "dead-lettered"; record: OutboxRecord; error: unknown }
  | { type: "unknown-kind"; record: OutboxRecord }
  | { type: "worker-error"; error: unknown };

/** Handle returned by {@link createWorker}. */
export type WorkerHandle = {
  /** Start the poll loop. Non-blocking; the loop runs on the event loop. */
  start(): void;
  /** Signal stop and await the in-flight dispatch (if any) to complete. */
  stop(): Promise<void>;
  /** `true` after {@link start} until {@link stop} resolves. */
  readonly running: boolean;
};
