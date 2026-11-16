# Contributing to stateledger

Thanks for looking. This is a solo-maintained project, so the most helpful
contributions are the ones that arrive with a clear problem statement and a
passing test. Small fixes can go straight to a pull request. For anything
that changes the public API, the adapter contract, or the schema SQL, open an
issue first so we can agree on the shape before you spend time on it.

## What goes where

- **Bug report**: use the bug form. It asks for the adapter, Postgres version,
  Node version, and locking mode because those four decide most diagnoses.
- **Feature or new adapter**: use the feature form.
- **Question about how to model something**: open a
  [discussion](https://github.com/enowdivine/stateledger/discussions) instead
  of an issue.
- **Security issue**: do not open an issue. See [SECURITY.md](./SECURITY.md).

## Setup

Requires **Node 20 or newer** and **pnpm 9 or newer**. The repo pins its
package manager in `package.json` (`packageManager`), so `corepack enable`
gets you the right pnpm automatically.

```bash
git clone https://github.com/enowdivine/stateledger.git
cd stateledger
pnpm install
pnpm build
```

The test suites resolve `@stateledger/core` to its source through vitest
aliases, so you do not need a build to run tests. You do need one to check
that a package's tsup and declaration output is still valid, which is why CI
builds before it tests and why the checklist asks for it.

## Commands

All of these run from the repo root.

```bash
pnpm build        # build every package in packages/
pnpm dev          # all packages in tsup watch mode
pnpm test         # unit tests plus the in-memory contract run
pnpm test:watch   # same, in watch mode
pnpm typecheck    # tsc --noEmit in every package
pnpm lint         # eslint across the repo
pnpm lint:fix     # eslint with --fix
pnpm format       # prettier --write
pnpm changeset    # record a release note and version bump
```

Per-package scripts run through pnpm's filter, which is how you narrow a long
loop to the thing you are editing:

```bash
pnpm --filter @stateledger/drizzle typecheck
pnpm --filter @stateledger/drizzle build
```

CI runs `lint`, `typecheck`, `build`, and `test` on Node 20 and 22, then the
integration job. Running those four locally before you push is the whole
pre-flight.

## Tests

There are two tiers, and the split is deliberate.

**Unit and in-memory tests** are `*.test.ts` files picked up by the default
vitest run. `pnpm test` runs them, needs no Docker, and should pass on any
machine. `packages/core/test/` holds the machine-definition tests and the
in-memory run of the shared contract suite.

**Integration tests** are `*.integration.ts` files. The extension keeps them
out of default discovery, so a contributor without Docker is not blocked by
them. Each adapter package has a `vitest.integration.config.ts` that widens
the include glob, exposed as `test:integration`:

```bash
# Needs Docker running. testcontainers boots a real postgres:16-alpine
# per suite and tears it down after.
pnpm --filter @stateledger/prisma prisma:generate   # once, for the Prisma test client
pnpm --filter @stateledger/prisma  test:integration
pnpm --filter @stateledger/drizzle test:integration
pnpm --filter @stateledger/pg      test:integration
pnpm --filter @stateledger/kysely  test:integration
pnpm --filter @stateledger/typeorm test:integration
pnpm --filter @stateledger/outbox  test:integration
```

First run pulls the Postgres image, so give it a minute. If you cannot run
these, say so in the pull request rather than ticking the checklist box. That
is fine for a docs change and a blocker for an adapter change.

## The contract suite is the bar

`packages/core/src/contract-tests.ts` exports `runContractTests`, a generic
suite that every adapter has to pass unmodified. It is the definition of
correct adapter behaviour, and it is the reason switching adapters is a
one-line change at the wiring point.

An adapter wires it up by handing over a setup hook that returns a live
adapter and a teardown:

```ts
import { runContractTests } from "@stateledger/core/contract-tests";

runContractTests({
  label: "kysely + node-postgres",
  setup: async () => ({ adapter, teardown: async () => { /* drop, close */ } }),
});
```

Two rules follow from this:

1. **Do not weaken the suite to make an adapter pass.** If your backend cannot
   satisfy a case, that is a finding about the backend, and it belongs in the
   issue discussion before any code lands.
2. **If you fix a bug in adapter behaviour, add the case to the shared suite**,
   not to one adapter's test file. A bug one adapter had is a bug the others
   can grow, and the shared suite is where that gets caught. Doing so means
   re-running the integration suite for every adapter.

The behaviours the suite exists to protect, spelled out in
`packages/core/src/adapter.ts`:

- `acquireLock` is tied to the transaction's lifetime. Commit or rollback
  releases it. There is no separate `releaseLock`.
- `readCurrent` queries `WHERE most_recent = true`. Never
  `ORDER BY sort_key DESC LIMIT 1`.
- `appendTransition` inserts the new row and flips the previous `most_recent`
  to `false` in the same transaction, raises `OptimisticConcurrencyError` when
  the partial unique index rejects the insert, and wraps every other database
  failure in `AdapterError` with the original on `cause`.
- `readHistory` returns rows ordered by `sort_key` ascending.
- `readStateAt` answers in a single query.
- `withTransaction` joins a transaction the caller already opened instead of
  opening a nested one.

## Adding an adapter

Copy an existing package. [`packages/kysely/`](./packages/kysely) is the
cleanest template because it has one driver and no code generation step.
[`packages/pg/`](./packages/pg) is the one to read if your adapter needs to
support two drivers from a single package.

The files involved, all of them small:

| File | What it holds |
|---|---|
| `package.json` | Name, `peerDependencies` on the ORM or driver, the standard `build`/`dev`/`typecheck`/`test`/`test:integration`/`clean` scripts. Copy them verbatim. |
| `tsconfig.json` | Extends `../../tsconfig.base.json`, includes `src`. |
| `tsup.config.ts` | ESM plus CJS, dts on, the ORM and `@stateledger/core` marked `external`. |
| `vitest.config.ts` | Path aliases pointing at core's source, plus the long hook timeouts Docker needs. |
| `vitest.integration.config.ts` | Merges the base config and includes `test/**/*.integration.ts`. |
| `src/types.ts` | The structural types for the client you accept, and your options type. |
| `src/adapter.ts` | The `Adapter` implementation. |
| `src/schema-sql.ts` | The DDL, including both unique indexes. Keep it identical to the other adapters. |
| `src/index.ts` | Public exports: the factory, the option types, the schema constants. |
| `test/<driver>.contract.integration.ts` | testcontainers boot, schema apply, `runContractTests`. |
| `README.md` | Install, wiring, locking modes, schema. Match the shape of the existing adapter READMEs. |

Two things outside the package directory:

- Add the package to `paths` in `tsconfig.base.json`.
- Add an integration step for it to `.github/workflows/ci.yml`, next to the
  existing adapter steps. An adapter nothing runs in CI will rot.

`pnpm-workspace.yaml` globs `packages/*`, so there is nothing to register
there.

## Postgres-only is a design decision, not an oversight

Every persistence adapter in this repo targets Postgres. That is not laziness
about portability. Two Postgres features carry the concurrency guarantees the
library advertises:

- **`pg_advisory_xact_lock`** gives the default pessimistic mode a per
  `(machine, subjectId)` lock scoped to the transaction, so concurrent
  transitions on one subject serialize and release correctly on commit or
  rollback without any cleanup path.
- **The partial unique index on `most_recent`** makes "exactly one current row
  per subject" a database invariant rather than an application convention. It
  is what turns a lost optimistic race into an `OptimisticConcurrencyError` at
  write time instead of a silently forked history.

Neither has a portable equivalent. MySQL's `GET_LOCK` is connection-scoped
rather than transaction-scoped, and MySQL has no filtered indexes at all.
CockroachDB speaks the Postgres wire protocol but has no advisory locks, which
is why the README sends you to optimistic mode and a retry there.

So a proposal to support a database lacking both cannot be evaluated on the
adapter code alone. It has to say what happens to those two guarantees: what
replaces them, or which one is being dropped and how that gets documented so
nobody puts the result in a payment path expecting the behaviour the README
describes. An adapter that passes the contract suite only because the suite
was relaxed is worse than no adapter.

## Changesets

Releases run on [changesets](https://github.com/changesets/changesets). Any
pull request that changes shipped code needs one:

```bash
pnpm changeset
```

Pick the affected packages, pick patch, minor, or major, and write the note as
something a user reading a changelog would want: what changed and what it
means for them, not "fix bug". The existing files in `.changeset/` are the
reference for tone and length.

Docs-only and CI-only changes do not need a changeset. Versioning and
publishing are maintainer steps, so do not run `pnpm version` or
`pnpm release` in a pull request.

## Style

Prettier and ESLint are configured, and the settings are not up for debate in
a pull request. Run `pnpm format` and `pnpm lint:fix` before pushing.

Beyond that, what review will actually push back on:

- **No `any`, and no `@ts-expect-error` without a comment** explaining why the
  escape hatch is correct. `tsconfig.base.json` turns on `strict`,
  `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. Write code that
  satisfies them rather than widening a type to get past them.
- **Type-only imports use `import type`.** Lint enforces it.
- **No `console.log`** in library code. `console.warn` and `console.error` are
  allowed where a warning is genuinely the right output.
- **Comments explain why.** The existing files are heavy on rationale and
  light on narration, and that is on purpose. Anyone reading an adapter needs
  to know why `most_recent` is queried the way it is, not that a line assigns
  a variable.
- **Errors carry structure.** Throw the specific class from
  `packages/core/src/errors.ts` with its fields populated, so callers can
  branch on it. A bare `Error` with a formatted string is not enough.

## Pull requests

Branch off `main`, keep the diff to one concern, and fill in the pull request
template. CI runs on every pull request to `main` and has to be green before
merge. Review is best-effort around client work, so expect days rather than
hours, and a nudge on a stale pull request is welcome rather than annoying.

## License

Contributions are accepted under the [MIT license](./LICENSE) that covers the
project. By opening a pull request you agree your contribution ships under it.
