import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@stateledger/core/contract-tests": resolve(__dirname, "../core/src/contract-tests.ts"),
      "@stateledger/core": resolve(__dirname, "../core/src/index.ts"),
      "@stateledger/memory": resolve(__dirname, "../memory/src/index.ts"),
      "@stateledger/drizzle": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    // Integration test boots Docker and pulls an image on cold runs.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
