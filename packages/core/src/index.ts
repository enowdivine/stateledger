/**
 * @stateledger/core — public surface.
 *
 * Adapters and user code import from this entry point. The companion entry
 * `@stateledger/core/contract-tests` is meant for adapter authors only.
 */

export {
  AdapterError,
  GuardRejected,
  InvalidTransition,
  OptimisticConcurrencyError,
  StaleSubjectError,
  StateledgerError,
} from "./errors.js";

export type { Adapter } from "./adapter.js";

export type {
  Actor,
  CallbackContext,
  GuardContext,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "./types.js";

export { defineMachine, Machine, NarrowedMachine } from "./define-machine.js";
export type { MachineFactory, InferMachineState } from "./define-machine.js";
export type {
  AllowedTargets,
  BindOptions,
  MachineConfig,
  StateOf,
  TransitionDecl,
  TransitionOptions,
  TransitionsOf,
} from "./machine-types.js";

/**
 * This package's version, as a public export.
 *
 * It is hand-maintained, and it had drifted: a 1.0.0 tarball shipped
 * `"0.0.1-experimental.0"` from here, which then turned up in consumers'
 * logs and bug reports and made every report it appeared in misleading.
 * Nothing in the build derives this from `package.json`, so the only thing
 * standing between it and the next drift is the test in
 * `test/version.test.ts`, which reads `package.json` and fails CI on a
 * mismatch. Bump both together, or let that test tell you that you did not.
 */
export const version = "1.0.0";
