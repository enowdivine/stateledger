/**
 * @stateledger/memory — in-memory adapter for stateledger.
 *
 * Backed by a plain `Map`. Useful for tests, hello-world demos, and
 * prototyping. State is lost on process exit; don't use in production.
 */

export { InMemoryAdapter, type InMemoryTx } from "./in-memory-adapter.js";
