/**
 * Public error classes for @stateledger/outbox.
 *
 * Mirrors the shape of `@stateledger/core`'s errors — a single base class
 * so users can catch everything with one filter, plus specific subclasses
 * carrying structured context for programmatic handling.
 */

/** Base class. All outbox errors extend this. */
export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A row was claimed for a `kind` that has no handler registered. The worker
 * marks the row `failed` immediately (dead letter) rather than retrying —
 * retries won't magically produce a handler.
 */
export class UnknownKindError extends OutboxError {
  constructor(
    public readonly kind: string,
    public readonly recordId: string,
  ) {
    super(
      `[outbox] ${recordId}: no handler registered for kind "${kind}". ` +
        `Register one in WorkerConfig.handlers or delete the row.`,
    );
  }
}

/**
 * Wraps any error thrown by the database (connection failure, constraint
 * violation, etc.). Original error preserved on `cause`.
 *
 * Users should not match on the shape of `cause` — it's driver-specific and
 * may change between adapter versions.
 */
export class OutboxAdapterError extends OutboxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
