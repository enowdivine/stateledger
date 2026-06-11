# Changesets

This folder is for [Changesets](https://github.com/changesets/changesets) — a tool that tracks intended package version bumps and aggregates them into a release.

## Workflow

1. After writing code that affects users, run:

   ```
   pnpm changeset
   ```

   You'll be prompted to pick the affected packages, the bump type (major / minor / patch), and write a short user-facing changelog entry.

2. Commit the resulting `.changeset/*.md` file alongside your code.

3. When ready to release, the release workflow runs `pnpm changeset version` (which bumps `package.json` versions + appends to `CHANGELOG.md`) and then `pnpm changeset publish` (which publishes to npm).

## Why we use this

- Independent versioning per package: `@stateledger/core` can be at 0.4 while `@stateledger/prisma` is at 0.2.
- Atomic "release this set of changes together" semantics across the monorepo.
- Generated `CHANGELOG.md` per package, so users can see exactly what changed.

`@stateledger/testing` is marked as `ignore` because it's an internal testing helper, not published.
