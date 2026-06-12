/**
 * Separate vitest config for the integration suite — pulls in only the
 * `.integration.ts` files so we can run them on demand without including
 * them in the workspace's default `pnpm test` run.
 *
 * Required because vitest 2.x doesn't expose an `--include` CLI flag, so
 * the include glob has to live in a config file.
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
