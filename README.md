# stateledger

> Database-backed state machine for Node and TypeScript. Transitions are persisted, audited, and concurrency-safe by default.

[![CI](https://github.com/enowdivine/stateledger/actions/workflows/ci.yml/badge.svg)](https://github.com/enowdivine/stateledger/actions/workflows/ci.yml)

**Status:** Early work-in-progress. Public API not yet stable; do not use in production.

The boring, audit-friendly kind of state machine — not the blockchain kind. Designed for payments, fintech, and any backend where you need to know exactly when each business record moved between states, who triggered it, and that no two processes can transition the same record at once.

## Why

The Node/TypeScript ecosystem has great in-memory state machines (XState) and standalone audit-log libraries, but nothing that combines:

1. **Persisted transitions** — every state change is a row in a `transitions` table, not just an in-memory event.
2. **Audit history** — immutable record of who/what/when, queryable as a first-class API.
3. **Built-in concurrency safety** — two processes cannot transition the same record simultaneously.

Ruby has [GoCardless Statesman](https://github.com/gocardless/statesman). Node/TS doesn't. That's the gap stateledger fills.

## Packages

| Package | What |
|---|---|
| [`@stateledger/core`](./packages/core) | Logic, types, `defineMachine`, the `Adapter` interface. Zero runtime deps. |
| [`@stateledger/prisma`](./packages/prisma) | Prisma adapter (Postgres). MVP target. |
| `@stateledger/drizzle` | Drizzle adapter. Roadmapped for v1.0. |
| `@stateledger/outbox` | Transactional outbox helper for side effects. Roadmapped for v1.0. |
| `@stateledger/testing` | Internal test fixtures and sample machines. Not published. |

## Development

```
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ and pnpm 9+.

## License

MIT — see [LICENSE](./LICENSE).
