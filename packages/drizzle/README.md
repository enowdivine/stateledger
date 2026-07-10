# @stateledger/drizzle

Drizzle + Postgres adapter for [stateledger](https://github.com/enowdivine/stateledger) — persisted, audited, concurrency-safe state machines for Node/TypeScript.

Works with any Drizzle Postgres driver: `node-postgres`, `postgres-js`, `neon-serverless`, `vercel-postgres`.

## Install

```sh
pnpm add @stateledger/core @stateledger/drizzle drizzle-orm
```

Plus a Drizzle-compatible Postgres driver (`pg`, `postgres`, `@neondatabase/serverless`, or `@vercel/postgres`).

## Apply the schema

The library expects a `stateledger_transitions` table. Apply it however you migrate:

```ts
import { STATELEDGER_SCHEMA_SQL } from "@stateledger/drizzle";
// paste into a migration file, or:
import { sql } from "drizzle-orm";
import { STATELEDGER_SCHEMA_STATEMENTS } from "@stateledger/drizzle";

for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
  await db.execute(sql.raw(stmt));
}
```

The DDL is identical to what `@stateledger/prisma` ships — same table, same indexes, same locking guarantees.

## Use it

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { defineMachine } from "@stateledger/core";
import { createDrizzleAdapter } from "@stateledger/drizzle";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const adapter = createDrizzleAdapter(db);

const payment = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "failed"] as const,
  transitions: {
    pending:    { authorize: "authorized", fail: "failed" },
    authorized: { capture: "captured", fail: "failed" },
  },
  adapter,
});

await payment.transition("pay_123", "authorize");
const current = await payment.readState("pay_123");
```

## Options

```ts
createDrizzleAdapter(db, {
  tableName: "stateledger_transitions",   // default; override for multi-tenant setups
  locking: "pessimistic",                 // default; use "optimistic" to skip pg_advisory_xact_lock
});
```

- **`pessimistic`** (default) — uses `pg_advisory_xact_lock(hashtextextended(machine:subject, 0))` per transition. Concurrent writers wait their turn.
- **`optimistic`** — skips the advisory lock and relies on the partial unique index on `most_recent`. Faster under low contention. Caller must catch `OptimisticConcurrencyError` and retry.

## Joining an existing transaction

Pass a Drizzle transaction context in place of the top-level client:

```ts
await db.transaction(async (tx) => {
  await stripe.paymentIntents.create(...);   // your business logic
  const adapter = createDrizzleAdapter(tx);  // joins the outer tx
  const machine = defineMachine({ ..., adapter });
  await machine.transition("pay_123", "authorize");
});
```

## Contract-conformant

Passes the same 13-spec [`@stateledger/core/contract-tests`](https://github.com/enowdivine/stateledger/blob/main/packages/core/src/contract-tests.ts) suite as `@stateledger/prisma` — reads, appends, rollback, `most_recent` flip invariants, cross-subject independence, and time-travel semantics.

Run it locally:

```sh
pnpm --filter @stateledger/drizzle test:integration
```

Requires Docker (uses `testcontainers` to boot a real Postgres).

## License

MIT
