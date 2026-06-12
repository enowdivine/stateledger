/**
 * @stateledger/testing — internal helper package.
 *
 * Re-exports the in-memory adapter so core's own tests (and future docs
 * examples) can pull a working `Adapter` implementation without spinning up
 * a database. Not published to npm.
 */

export { InMemoryAdapter, type InMemoryTx } from "./in-memory-adapter.js";
