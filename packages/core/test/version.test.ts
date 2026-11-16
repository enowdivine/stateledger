/**
 * Guards the one thing in this package that no compiler or type can catch:
 * that the `version` we EXPORT matches the version we PUBLISH.
 *
 * This is not hypothetical tidiness. `@stateledger/core@1.0.0` went to npm
 * exporting `version = "0.0.1-experimental.0"`, because the constant is
 * hand-written in `src/index.ts` and nothing derived it from `package.json`.
 * A wrong version export is uniquely annoying: it is public, so it lands in
 * consumers' logs and in the bug reports they send you, and it makes every
 * one of those reports point at the wrong release.
 *
 * Deriving the constant from `package.json` at build time would remove the
 * need for this test, but it would also put a JSON import into the published
 * entry point and change how the package resolves. A unit test is the
 * cheaper trade: the drift becomes a red CI run instead of a silent publish.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { version } from "../src/index.js";

describe("version export", () => {
  it("matches the version in package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };

    expect(version).toBe(manifest.version);
  });
});
