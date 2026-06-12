/**
 * Runs the generic Adapter contract test pack against the in-memory adapter.
 *
 * This is the proof that the contract pack itself is sound — if a known-good
 * adapter passes it, real adapters can be measured against the same bar.
 */

import { runContractTests } from "../src/contract-tests.js";
import { InMemoryAdapter } from "@stateledger/memory";

runContractTests({
  label: "InMemoryAdapter",
  setup: async () => {
    return {
      adapter: new InMemoryAdapter(),
      teardown: async () => {
        // Nothing to clean — a fresh adapter is built per-test.
      },
    };
  },
});
