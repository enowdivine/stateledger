---
"@stateledger/core": patch
"@stateledger/memory": patch
"@stateledger/prisma": patch
"@stateledger/drizzle": patch
"@stateledger/outbox": patch
---

Fix two packaging defects that affected every published package. Both were found by smoke testing the packed tarballs as a real consumer would install them, which nothing had ever done: the whole test suite runs against `src`, so the published artifact was an untested path.

**The packages were unusable from CommonJS TypeScript.** Every package ships a `dist/index.d.cts` alongside its ESM `dist/index.d.ts`, and no `package.json` referenced the `.d.cts` anywhere. The `exports` map carried a single `types` condition pointing at the ESM declaration file, and because these packages are `"type": "module"` that file is ESM, so a `.cts` consumer on `module: node16` or `node18` got `TS1479` on every import. TypeScript 5.9 under `nodenext` hides the problem, since it permits `require()` of ESM, which is why this survived to 1.0.

Each entry now declares its own types per condition, so a CJS consumer resolves the `.cts` declarations that were already being published:

```json
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```

`@stateledger/core`'s `./contract-tests` subpath gets the same treatment.

**`@stateledger/core` exported the wrong version.** The 1.0.0 tarball exported `version = "0.0.1-experimental.0"`. It is a public export, so the wrong string reached consumers' logs and the bug reports they filed from them, making every such report point at the wrong release. The constant is hand-written and nothing derived it from `package.json`, so correcting the string alone would have left it free to drift again. It is now `"1.0.0"`, and a unit test reads `package.json` and fails CI on any future mismatch.
