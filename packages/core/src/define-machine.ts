/**
 * defineMachine — the public factory.
 *
 * Takes a literal config object and returns a `MachineFactory` that binds
 * to subjects at call time. The `as const` on the config is load-bearing:
 * without it, `states` widens to `string[]` and the inference collapses.
 */

import { GuardRejected, InvalidTransition, StaleSubjectError } from "./errors.js";
import type { NewTransitionRow, TransitionRow } from "./types.js";
import type {
  AllowedTargets,
  BindOptions,
  MachineConfig,
  StateOf,
  TransitionOptions,
} from "./machine-types.js";

const SYSTEM_ACTOR = { id: "system", type: "SYSTEM" } as const;

/** Bound machine instance. Returned by `Factory.for(subjectId, opts)`. */
export class Machine<C extends MachineConfig, TxHandle = unknown, Subject = unknown> {
  constructor(
    public readonly config: C,
    public readonly subjectId: string,
    private readonly opts: BindOptions<TxHandle, Subject>,
  ) {}

  /**
   * Narrow `transitionTo` to states reachable from `from`. Pure type-level
   * sugar — runtime behavior is identical to calling `transitionTo` directly,
   * the difference is that TS autocompletes only the valid targets.
   */
  in<From extends StateOf<C>>(from: From): NarrowedMachine<C, From, TxHandle> {
    return new NarrowedMachine<C, From, TxHandle>(this, from);
  }

  /**
   * Read the most recent transition row, or null if the subject has never
   * transitioned.
   */
  async readCurrent(): Promise<TransitionRow<StateOf<C>> | null> {
    const { adapter, tx } = this.opts;
    if (tx !== undefined) {
      return (await adapter.readCurrent(tx, this.config.name, this.subjectId)) as
        | TransitionRow<StateOf<C>>
        | null;
    }
    return adapter.withTransaction(async (innerTx) => {
      return (await adapter.readCurrent(
        innerTx,
        this.config.name,
        this.subjectId,
      )) as TransitionRow<StateOf<C>> | null;
    });
  }

  /** Read every transition for this subject, oldest first. */
  async history(): Promise<TransitionRow<StateOf<C>>[]> {
    const rows = await this.opts.adapter.readHistory(
      this.opts.tx ?? null,
      this.config.name,
      this.subjectId,
    );
    return rows as TransitionRow<StateOf<C>>[];
  }

  /** Has this subject ever been in `state`? */
  async hasBeenIn(state: StateOf<C>): Promise<boolean> {
    const history = await this.history();
    return history.some((r) => r.toState === state);
  }

  /**
   * Return the state this subject was in at `at` — i.e. the most recent
   * transition whose `createdAt <= at`. Returns `null` when the subject
   * had no transitions yet at that moment.
   *
   * Reconstructed from the persisted history; no replay or simulation —
   * the row's `toState` IS the state at that moment because every
   * transition is timestamped at write time.
   *
   * Useful for customer support ("what state was this in when the issue
   * happened?"), compliance / audit ("end-of-quarter snapshots"), and
   * scheduled jobs ("charge everyone whose subscription was 'active' on
   * the first of the month").
   *
   * Note on "right after a transition" queries: if you need a cutoff that
   * is guaranteed to land just after a specific transition's commit,
   * anchor to the row's own `createdAt` rather than `new Date()`. The
   * DB clock and the host clock can drift by tens of milliseconds in
   * either direction — `transitionTo()` returns the inserted row, so:
   *
   *   const row = await machine.transitionTo("active");
   *   const justAfter = new Date(row.createdAt.getTime() + 1);
   *   await machine.stateAt(justAfter); // → "active", reliably
   */
  async stateAt(at: Date): Promise<StateOf<C> | null> {
    const row = await this.opts.adapter.readStateAt(
      this.opts.tx ?? null,
      this.config.name,
      this.subjectId,
      at,
    );
    return row ? (row.toState as StateOf<C>) : null;
  }

  /**
   * Transition to `to`. Validates declaratively, runs the guard if any,
   * appends the row, then runs the after-callback. All inside a single
   * transaction (either the caller's `tx` or a fresh one).
   *
   * First transition on a subject is the "bootstrap" — it must target the
   * declared `initialState`. Subsequent transitions must be declared in
   * the `transitions` array.
   */
  async transitionTo<To extends StateOf<C>>(
    to: To,
    options: TransitionOptions = {},
  ): Promise<TransitionRow<StateOf<C>>> {
    return this.runTransition(to, options);
  }

  private async runTransition(
    to: string,
    options: TransitionOptions,
  ): Promise<TransitionRow<StateOf<C>>> {
    const { adapter, actor: boundActor, subject, tx: passedTx, subjectStateColumn } = this.opts;
    const actor = options.actor ?? boundActor ?? SYSTEM_ACTOR;
    const { name: machineName, states, transitions, initialState } = this.config;
    const version = this.config.version ?? 1;

    const work = async (tx: TxHandle): Promise<TransitionRow<StateOf<C>>> => {
      await adapter.acquireLock(tx, machineName, this.subjectId);

      const current = await adapter.readCurrent(tx, machineName, this.subjectId);
      const from = current?.toState ?? null;

      // Validate transition is allowed under the current definition.
      if (current === null) {
        // Bootstrap: only the declared initialState is valid as the first transition.
        if (to !== initialState) {
          throw new InvalidTransition(machineName, this.subjectId, null, to);
        }
      } else {
        if (!(states as readonly string[]).includes(current.toState)) {
          throw new StaleSubjectError(machineName, this.subjectId, current.toState);
        }
        const allowed = transitions.some((t) => t.from === current.toState && t.to === to);
        if (!allowed) {
          throw new InvalidTransition(machineName, this.subjectId, current.toState, to);
        }
      }

      // Run guard if one is registered for this exact (from, to) pair.
      // Bootstrap transitions can't have guards — they have no `from` state.
      if (from !== null) {
        const guardKey = `${from}->${to}`;
        const guard = this.config.guards?.[guardKey];
        if (guard) {
          const ok = await guard({ subject, from, to, actor });
          if (ok === false) {
            throw new GuardRejected(machineName, this.subjectId, from, to);
          }
        }
      }

      const newRow: NewTransitionRow = {
        machine: machineName,
        subjectId: this.subjectId,
        fromState: from,
        toState: to,
        sortKey: current ? current.sortKey + 1 : 1,
        mostRecent: true,
        actorId: actor.id,
        actorType: actor.type,
        metadata: options.metadata ?? {},
        machineVersion: version,
      };
      const inserted = await adapter.appendTransition(tx, newRow);

      // After-callbacks. Bootstrap uses the "<initial>" sentinel in the key
      // so users can register a callback for the very first transition.
      const callbackKey = `after:${from ?? "<initial>"}->${to}`;
      const callback = this.config.callbacks?.[callbackKey];
      if (callback) {
        await callback({ subject, from: from ?? "<initial>", to, actor, tx });
      }

      // Optionally maintain a denormalized state column on the subject row.
      if (subjectStateColumn && adapter.updateSubjectState) {
        await adapter.updateSubjectState(tx, subjectStateColumn, to);
      }

      return inserted as TransitionRow<StateOf<C>>;
    };

    return passedTx !== undefined ? work(passedTx) : adapter.withTransaction(work);
  }
}

/**
 * Wrapper that narrows `transitionTo`'s parameter to states reachable from
 * the `from` state passed to `.in()`. Runtime delegates to the wrapped
 * Machine — the narrowing is purely compile-time.
 */
export class NarrowedMachine<
  C extends MachineConfig,
  From extends StateOf<C>,
  TxHandle = unknown,
> {
  constructor(
    private readonly machine: Machine<C, TxHandle>,
    private readonly from: From,
  ) {}

  async transitionTo<To extends AllowedTargets<C, From>>(
    to: To,
    options: TransitionOptions = {},
  ): Promise<TransitionRow<StateOf<C>>> {
    // The `as` is safe — AllowedTargets is a subset of StateOf<C> by construction.
    return this.machine.transitionTo(to as unknown as StateOf<C>, options);
  }

  /** Expose the from-state for symmetry with `.config`. */
  get state(): From {
    return this.from;
  }
}

/** Returned by `defineMachine`. Holds the config and creates bound `Machine`s. */
export type MachineFactory<C extends MachineConfig> = {
  readonly config: C;
  for<TxHandle = unknown, Subject = unknown>(
    subjectId: string,
    opts: BindOptions<TxHandle, Subject>,
  ): Machine<C, TxHandle, Subject>;
};

/**
 * Define a machine. Pass the config literal `as const` so TypeScript narrows
 * the State union; without it, `states` widens to `string[]` and the inference
 * useful chain (`.in(state).transitionTo(...)` narrowing) is lost.
 */
export function defineMachine<C extends MachineConfig>(config: C): MachineFactory<C> {
  return {
    config,
    for<TxHandle = unknown, Subject = unknown>(
      subjectId: string,
      opts: BindOptions<TxHandle, Subject>,
    ): Machine<C, TxHandle, Subject> {
      return new Machine(config, subjectId, opts);
    },
  };
}

/** Extract the State union from a MachineFactory. */
export type InferMachineState<F> = F extends { config: infer C }
  ? C extends MachineConfig
    ? StateOf<C>
    : never
  : never;
