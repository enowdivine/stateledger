---
"@stateledger/drizzle": minor
---

New adapter: `@stateledger/drizzle` — Postgres adapter for Drizzle ORM users.

Passes the same 13-spec contract test suite as `@stateledger/prisma`. Works with any Drizzle Postgres driver (`node-postgres`, `postgres-js`, `neon-serverless`, `vercel-postgres`) via structural typing on `execute()` and `transaction()`. Same table, same indexes, same pessimistic/optimistic locking modes as the Prisma adapter — safe to run alongside it against the same database.
