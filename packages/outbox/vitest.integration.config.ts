/**
 * Separate vitest config for the integration suite — pulls in only the
 * `.integration.ts` files so we can run them on demand without including
 * them in the workspace's default `pnpm test` run (which contributors run
 * without Docker).
 */

import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["test/**/*.integration.ts"],
    },
  }),
);
