# @stateledger/pg

Raw-Postgres adapter for [stateledger](https://github.com/enowdivine/stateledger) | persisted, audited, concurrency-safe state machines for Node/TypeScript, with no ORM in the stack.

If your backend talks to Postgres through [`pg`](https://node-postgres.com) or [`postgres`](https://github.com/porsager/postgres) and nothing else, this is the adapter. You pass your pool or your `sql` instance. There is no model to declare, no schema file to extend, and nothing Prisma- or Drizzle-shaped to fabricate.

Pairs with [`@stateledger/outbox`](https://www.npmjs.com/package/@stateledger/outbox) for external side effects that must ship atomically with a transition.

## Install

```sh
pnpm add @stateledger/core @stateledger/pg
```

Plus whichever driver you already use. Both are optional peers, so install only the one you have:

```sh
pnpm add pg          # node-postgres
pnpm add postgres    # postgres.js
```

## Apply the schema

The library expects a `stateledger_transitions` table. Apply it however you migrate:

```ts
import { STATELEDGER_SCHEMA_SQL } from "@stateledger/pg";
// paste into a migration file, or run the statements one at a time:
import { STATELEDGER_SCHEMA_STATEMENTS } from "@stateledger/pg";

for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
  await pool.query(stmt);        // node-postgres
  // await sql.unsafe(stmt);     // postgres.js
}
```

The DDL is identical to what `@stateledger/prisma` and `@stateledger/drizzle` ship: same table, same indexes, same locking guarantees. The partial unique index on `most_recent` is not optional | it is the invariant that makes "exactly one current state per subject" a database fact rather than a hope.

## node-postgres

```ts
import { Pool } from "pg";
import { defineMachine } from "@stateledger/core";
import { createPgAdapter } from "@stateledger/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = createPgAdapter(pool);

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

Given a `Pool`, the adapter checks a connection out per transition, sends `BEGIN` / `COMMIT` / `ROLLBACK` itself, and always returns the connection to the pool | including when the transition throws, and including when the `ROLLBACK` itself fails (in which case the connection is destroyed rather than handed to the next borrower).

## postgres.js

```ts
import postgres from "postgres";
import { defineMachine } from "@stateledger/core";
import { createPostgresJsAdapter } from "@stateledger/pg";

const sql = postgres(process.env.DATABASE_URL!);
const adapter = createPostgresJsAdapter(sql);

const payment = defineMachine({ /* ...as above... */ adapter });
```

Transactions go through `sql.begin()`, which owns the BEGIN/COMMIT/ROLLBACK and the connection lease, so there is nothing for the adapter to release.

`transform: postgres.camel` is safe to leave on. Every read and the insert's `RETURNING` project an explicit camelCase alias per column and project `metadata` as `::text`, so the camel transform has nothing to rewrite: it maps snake_case to camelCase, which is a no-op on names that contain no underscore, and it only recurses into json and jsonb *values*, which a text column is not. Without that projection the transform would quietly rewrite the keys of your own metadata, turning `{ payment_intent: "pi_1" }` into `{ paymentIntent: "pi_1" }` on the way out.

`transform: postgres.kebab` is also safe, for the same reason: it maps `_` to `-`, and no alias here contains an underscore. `transform: postgres.pascal` is not supported, because it upper-cases the first letter of every result key and so mangles the adapter's own aliases (`id` arrives as `Id`). The adapter detects that and throws a named error rather than mapping a row of `undefined`s. Use a second `postgres()` instance for stateledger if your app needs pascal.

## Options

Both factories take the same options:

```ts
createPgAdapter(pool, {
  tableName: "stateledger_transitions",   // default; override for multi-tenant setups
  locking: "pessimistic",                 // default; use "optimistic" to skip pg_advisory_xact_lock
});
```

- **`pessimistic`** (default) | uses `pg_advisory_xact_lock(hashtextextended('machine:subject', 0))` per transition. Concurrent writers wait their turn. The lock is held by the transaction and released when it ends.
- **`optimistic`** | skips the advisory lock and relies on the partial unique index on `most_recent`. Faster under low contention. Caller must catch `OptimisticConcurrencyError` and retry.

`tableName` must be a plain unquoted identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`, 63 characters or fewer) and is rejected at construction time otherwise. No driver can bind an identifier as a parameter, so the table name has to reach the query as text; a whitelist plus double quoting is what keeps that from being an injection hole. Schema-qualified names (`app.transitions`) are deliberately not accepted | set `search_path` on the connection instead.

## Joining an existing transaction

Both factories accept a transaction context in place of the root client, so a transition can commit atomically with the rest of your unit of work.

node-postgres | pass the checked-out client. The adapter then runs on that connection and emits no transaction control statements of its own, and does not release it:

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE payments SET ... WHERE id = $1", ["pay_123"]);

  const machine = defineMachine({ /* ... */ adapter: createPgAdapter(client) });
  await machine.transition("pay_123", "authorize");

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}
```

postgres.js | pass the transaction `sql`. The adapter's nested `begin()` becomes a savepoint on the same connection, so a failed transition rolls back to the savepoint without aborting your transaction:

```ts
await sql.begin(async (tx) => {
  await tx`UPDATE payments SET updated_at = NOW() WHERE id = ${"pay_123"}`;

  const machine = defineMachine({ /* ... */ adapter: createPostgresJsAdapter(tx) });
  await machine.transition("pay_123", "authorize");
});
```

The transaction handle also reaches your `after:` callbacks as `tx`, so writes you make there are part of the same atomic unit as the transition row:

```ts
callbacks: {
  "after:pending->authorized": async ({ tx, subject }) => {
    // node-postgres: tx.query(text, values)
    // postgres.js:   tx.unsafe(text, values), or cast to postgres.TransactionSql
    //                for the tagged-template API
    await enqueue(tx, { kind: "payment.authorized", payload: { id: subject.id } });
  },
}
```

## Contract-conformant

Passes the same 13-spec [`@stateledger/core/contract-tests`](https://github.com/enowdivine/stateledger/blob/main/packages/core/src/contract-tests.ts) suite as `@stateledger/prisma` and `@stateledger/drizzle`, once per driver: reads, appends, rollback, `most_recent` flip invariants, cross-subject independence, and time-travel semantics.

Run it locally:

```sh
pnpm --filter @stateledger/pg test:integration
```

Requires Docker (uses `testcontainers` to boot a real Postgres).

## License

MIT
