## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem being solved. Skip if the issue already covers it. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (unit plus the in-memory contract run)
- [ ] `pnpm changeset` run, with a patch/minor/major bump per affected package. Omit only for docs-only or CI-only changes.

Adapter changes also need:

- [ ] The shared contract suite from `packages/core/src/contract-tests.ts` passes against real Postgres: `pnpm --filter @stateledger/<pkg> test:integration`. Needs Docker, since testcontainers boots the database.
- [ ] Ran that suite for every adapter this touches, not only the one you were working in. Anything changing core or the schema SQL touches all of them.

## Notes for review

<!-- Tradeoffs you made, anything you want a second opinion on, anything
     deliberately left out of scope. Say so if you could not run the
     integration suite and why, rather than ticking the box. -->
