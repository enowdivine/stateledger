/**
 * Public error classes for stateledger.
 *
 * Every error thrown by the library extends {@link StateledgerError} so users
 * can catch all of them with one filter. Specific subclasses carry the
 * structured context callers need to handle the failure programmatically —
 * never just a string message.
 */

/** Base class. All stateledger errors extend this. */
export class StateledgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Preserve the prototype chain across V8 (Node) boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The requested transition isn't declared in the machine definition.
 *
 * Distinct from {@link GuardRejected}: this is a "the contract doesn't allow
 * this at all" error, not "the contract allows it conditionally and the
 * condition wasn't met."
 */
export class InvalidTransition extends StateledgerError {
  constructor(
    public readonly machine: string,
    public readonly subjectId: string,
    public readonly from: string | null,
    public readonly attemptedTo: string,
  ) {
    super(
      `[${machine}] ${subjectId}: no transition declared from "${from ?? "<initial>"}" to "${attemptedTo}".`,
    );
  }
}

/** A guard registered on the transition returned false (or threw a falsy reason). */
export class GuardRejected extends StateledgerError {
  constructor(
    public readonly machine: string,
    public readonly subjectId: string,
    public readonly from: string,
    public readonly to: string,
    public readonly reason?: string,
  ) {
    super(
      `[${machine}] ${subjectId}: guard rejected transition "${from}" → "${to}"${reason ? `: ${reason}` : ""}.`,
    );
  }
}

/**
 * Optimistic concurrency violation: another writer transitioned the same
 * subject between our read and write. Caller is expected to retry.
 *
 * Only raised when the machine is configured with `locking: "optimistic"`.
 * The pessimistic default never raises this — it blocks on the lock instead.
 */
export class OptimisticConcurrencyError extends StateledgerError {
  constructor(
    public readonly machine: string,
    public readonly subjectId: string,
  ) {
    super(`[${machine}] ${subjectId}: lost optimistic concurrency race; retry.`);
  }
}

/**
 * The subject is in a state the current machine definition no longer knows
 * about — usually because a state was removed from the definition without
 * migrating existing rows.
 *
 * Surfacing this as a distinct error keeps "I have a stale row" from being
 * confused with "I declared this transition wrong."
 */
export class StaleSubjectError extends StateledgerError {
  constructor(
    public readonly machine: string,
    public readonly subjectId: string,
    public readonly unknownState: string,
  ) {
    super(
      `[${machine}] ${subjectId}: stored state "${unknownState}" is not in the current machine definition.`,
    );
  }
}

/**
 * Wraps any error thrown by the adapter (DB connection failure, constraint
 * violation, etc.). The original error is preserved on `cause`.
 *
 * Users should not match on the `cause` shape — that's adapter-specific and
 * may change between adapter versions.
 */
export class AdapterError extends StateledgerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      // Use the standard Error.cause slot (Node 16+).
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
