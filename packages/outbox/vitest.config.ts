import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@stateledger/core": resolve(__dirname, "../core/src/index.ts"),
      "@stateledger/outbox": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    // Integration tests boot Docker and pull an image on cold runs.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
