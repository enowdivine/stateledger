import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/contract-tests.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: "node20",
  // Don't bundle vitest into contract-tests.js — it's a peer dep, the
  // consumer's project provides it at test time.
  external: ["vitest"],
});
