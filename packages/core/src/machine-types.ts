/**
 * Type-level helpers for defineMachine. These types power the compile-time
 * narrowing on `.in(state).transitionTo(...)` — they're what makes the
 * library feel "TypeScript-native."
 */

import type { Adapter } from "./adapter.js";
import type { Actor, GuardContext, CallbackContext, SubjectStateHint } from "./types.js";

/**
 * A transition declaration. Both `from` and `to` are concrete state strings
 * (no nulls — bootstrap rows are managed by the library, not declared).
 */
export type TransitionDecl = { readonly from: string; readonly to: string };

/**
 * The shape `defineMachine` accepts. Users pass this literal (with `as const`)
 * and the library narrows the State union for them.
 *
 * Guards and callbacks are keyed by `"${from}->${to}"`. For "after" callbacks
 * the key is `"after:${from}->${to}"`. Missing entries are fine — guards
 * default to "allowed" and callbacks default to no-op.
 */
export type MachineConfig = {
  readonly name: string;
  readonly states: readonly string[];
  readonly initialState: string;
  readonly transitions: readonly TransitionDecl[];
  readonly version?: number;
  // Keyed by `${from}->${to}` — return false to reject.
  readonly guards?: Readonly<
    Record<string, (ctx: GuardContext) => boolean | Promise<boolean>>
  >;
  // Keyed by `after:${from}->${to}` — runs inside the same transaction.
  readonly callbacks?: Readonly<
    Record<string, (ctx: CallbackContext) => void | Promise<void>>
  >;
};

/** Union of all state names declared on the config. */
export type StateOf<C extends MachineConfig> = C["states"][number];

/** Union of all transition declarations. */
export type TransitionsOf<C extends MachineConfig> = C["transitions"][number];

/** Given a state, the union of states reachable from it via a declared transition. */
export type AllowedTargets<C extends MachineConfig, From extends StateOf<C>> = Extract<
  TransitionsOf<C>,
  { from: From }
>["to"];

/** Options passed to `Factory.for(subjectId, opts)`. */
export type BindOptions<TxHandle = unknown, Subject = unknown> = {
  adapter: Adapter<TxHandle>;
  /** Default actor recorded on every transition unless overridden per-call. */
  actor?: Actor;
  /** Subject row — forwarded to guards/callbacks. Optional; useful for guards
   *  that need to read business data. */
  subject?: Subject;
  /** Existing transaction handle to join. When set, the machine joins this
   *  transaction instead of opening its own. */
  tx?: TxHandle;
  /** Adapter-specific hint for updating a denormalized state column on the
   *  subject's own row (e.g. for Prisma: `{ model, where, column }`). */
  subjectStateColumn?: SubjectStateHint;
};

/** Per-call options for `transitionTo`. */
export type TransitionOptions = {
  /** Arbitrary JSON stored on the transition row. */
  metadata?: Record<string, unknown>;
  /** Override the bind-time actor for this single call. */
  actor?: Actor;
};
