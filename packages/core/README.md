# @stateledger/core

> ⚠️ **Placeholder release — name reservation only.**
>
> This `experimental` tag exists so the `@stateledger` npm scope is bound. The package currently exports nothing useful. Do not install it expecting working features.
>
> Follow [the GitHub repo](https://github.com/enowdivine/stateledger) for status. The first real release will publish to the `latest` tag.

---

ORM-agnostic core of [**stateledger**](https://github.com/enowdivine/stateledger) — a database-backed state machine for Node and TypeScript. The boring, audit-friendly kind, not the blockchain kind.

## Why this exists

The Node/TS ecosystem has great in-memory state machines ([XState](https://xstate.js.org)) and standalone audit-log libraries, but nothing that combines:

1. **Persisted transitions** — every state change is a row in a `transitions` table.
2. **Audit history** — immutable record of who/what/when, queryable as a first-class API.
3. **Built-in concurrency safety** — two processes cannot transition the same record simultaneously.

Ruby has [GoCardless Statesman](https://github.com/gocardless/statesman). Node/TS didn't, until now.

## Roadmap

| Status | Item |
|---|---|
| 🟡 Active | `Adapter` interface + contract test pack |
| ⏳ Next | `defineMachine` with full TS inference |
| ⏳ Next | Schema + locking strategy (advisory locks, Postgres-first) |
| 🔜 v0.1 | First working release alongside `@stateledger/prisma` |
| 🔜 v1.0 | Drizzle adapter, transactional outbox helper |

See the [architecture doc](https://github.com/enowdivine/stateledger#architecture) for design rationale.

## License

MIT
