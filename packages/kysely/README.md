# @stateledger/kysely

Kysely + Postgres adapter for [stateledger](https://github.com/enowdivine/stateledger) | persisted, audited, concurrency-safe state machines for Node/TypeScript.

Built for the same reason people pick Kysely: full type safety without an ORM. stateledger narrows transitions at compile time, Kysely narrows queries at compile time, and neither one wants a runtime to own your schema.

Pairs with [`@stateledger/outbox`](https://www.npmjs.com/package/@stateledger/outbox) for external side effects that must ship atomically with a transition.

## Install

```sh
pnpm add @stateledger/core @stateledger/kysely kysely pg
```

Postgres only. The advisory lock and the partial unique index this adapter relies on are Postgres features, so use it with `PostgresDialect` (or a Postgres-compatible dialect such as PGlite or Neon).

## Apply the schema

The library expects a `stateledger_transitions` table. Apply it however you migrate | from a Kysely migration:

```ts
import { sql, type Kysely } from "kysely";
import { STATELEDGER_SCHEMA_STATEMENTS } from "@stateledger/kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per `execute()`: Kysely compiles and sends a single
  // statement per round trip.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await sql.raw(stmt).execute(db);
  }
}
```

`STATELEDGER_SCHEMA_SQL` is the same DDL as one multi-statement script, for pasting into a `.sql` file. The DDL is identical to what `@stateledger/prisma` and `@stateledger/drizzle` ship | same table, same indexes, same locking guarantees.

You do **not** need to add `stateledger_transitions` to your `Database` interface. The adapter speaks raw SQL against that one table and never consults your schema type.

## Use it

```ts
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { defineMachine } from "@stateledger/core";
import { createKyselyAdapter } from "@stateledger/kysely";

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  }),
});

const adapter = createKyselyAdapter(db);

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
createKyselyAdapter(db, {
  tableName: "stateledger_transitions",   // default; override for multi-tenant setups
  locking: "pessimistic",                 // default; use "optimistic" to skip pg_advisory_xact_lock
});
```

- **`pessimistic`** (default) | uses `pg_advisory_xact_lock(hashtextextended(machine:subject, 0))` per transition. Concurrent writers wait their turn.
- **`optimistic`** | skips the advisory lock and relies on the partial unique index on `most_recent`. Faster under low contention. Caller must catch `OptimisticConcurrencyError` and retry.

## Joining an existing transaction

Pass a Kysely `Transaction` in place of the top-level client:

```ts
await db.transaction().execute(async (trx) => {
  await stripe.paymentIntents.create(...);  // your business logic
  const adapter = createKyselyAdapter(trx); // joins the outer tx
  const machine = defineMachine({ ..., adapter });
  await machine.transition("pay_123", "authorize");
});
```

The adapter detects a transaction through Kysely's `isTransaction` flag and runs inside it instead of opening its own. It never nests, which matters because a Kysely `Transaction` extends `Kysely` and calling `.transaction()` on one throws.

## Plugins

Kysely result plugins apply to raw `sql` queries too, so the adapter is written to be indifferent to them:

- Every column is aliased in SQL to the camelCase name the library uses, and `metadata` is read as `::text` and parsed here. That makes reads identical with or without `CamelCasePlugin`, and keeps **your** metadata keys exactly as you wrote them (`CamelCasePlugin` otherwise rewrites the keys of nested objects, so `{ payment_intent: "pi_1" }` would come back as `{ paymentIntent: "pi_1" }`).
- One caveat it cannot cover: `CamelCasePlugin` snake_cases identifiers, including the table name. Keep a custom `tableName` snake_case (the default already is) or the plugin will rewrite it.
- `CamelCasePlugin({ upperCase: true })` goes further and uppercases its output, so even a snake_case `tableName` is rewritten: the adapter will address `"STATELEDGER_TRANSITIONS"`, and quoted identifiers are case-sensitive in Postgres. The same applies to the `model`, `column` and `where` keys of `subjectStateColumn`. Under that option, create the tables uppercase or don't install the plugin on the client you hand to the adapter.

## Contract-conformant

Passes the same 13-spec [`@stateledger/core/contract-tests`](https://github.com/enowdivine/stateledger/blob/main/packages/core/src/contract-tests.ts) suite as `@stateledger/prisma` and `@stateledger/drizzle` | reads, appends, rollback, `most_recent` flip invariants, cross-subject independence, and time-travel semantics.

Run it locally:

```sh
pnpm --filter @stateledger/kysely test:integration
```

Requires Docker (uses `testcontainers` to boot a real Postgres). The same command also runs this package's own edge-case suites (`test/edge-cases.integration.ts`, `test/plugin-matrix.integration.ts`), which cover joined transactions, optimistic locking, the identifier guard, `updateSubjectState`, jsonb and `Date` parameter binding, and the plugin matrix above.

## License

MIT
