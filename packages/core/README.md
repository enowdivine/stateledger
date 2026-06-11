# @stateledger/core

ORM-agnostic core of [stateledger](https://github.com/enowdivine/stateledger) — database-backed state machine for Node and TypeScript.

> Early WIP. Public API not yet stable. Do not use in production.

## What's here

- `defineMachine` — declarative state machine factory with full TS inference
- `Adapter` interface — the contract every persistence adapter implements
- `contract-tests` — generic test suite adapter authors run

## What's not

- Any specific adapter. Use `@stateledger/prisma` for Prisma, etc.

## License

MIT
