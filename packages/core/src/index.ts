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

export const version = "0.0.1-experimental.0";
