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
});
