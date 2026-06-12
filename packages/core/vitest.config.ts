import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@stateledger/core/contract-tests": resolve(__dirname, "src/contract-tests.ts"),
      "@stateledger/core": resolve(__dirname, "src/index.ts"),
      "@stateledger/testing": resolve(__dirname, "../testing/src/index.ts"),
    },
  },
});
