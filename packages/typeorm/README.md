# @stateledger/typeorm

TypeORM + Postgres adapter for [stateledger](https://github.com/enowdivine/stateledger), persisted, audited, concurrency-safe state machines for Node/TypeScript.

Works with TypeORM 0.3.x and 1.x. The adapter only needs `query(sql, params)` and `transaction(fn)`, which are identical across both lines, so the peer range is deliberately wide and nothing here pins you to a major.

Pairs with [`@stateledger/outbox`](https://www.npmjs.com/package/@stateledger/outbox) for external side effects that must ship atomically with a transition.

## Install

```sh
pnpm add @stateledger/core @stateledger/typeorm typeorm pg
```

## Apply the schema

The library expects a `stateledger_transitions` table, and it is created by raw DDL rather than by an entity class. If your instinct is to look for a `@Entity()` to import, there isn't one, by design: the table has a partial unique index on `most_recent` and an index on `(machine, subject_id, sort_key DESC)` that TypeORM's schema builder cannot express, and the DDL is shared verbatim with the Prisma and Drizzle adapters so every backend gets identical guarantees.

What that means in practice:

- **`synchronize: true` ignores this table.** It is not in your entity metadata, so TypeORM will neither create it nor drop it. That is the intended behaviour, and it is also why `synchronize` is not a way to install it.
- **`typeorm migration:generate` will never emit it.** Generation diffs entity metadata against the database, and there is no metadata here. Write the migration by hand once.

```ts
// src/migrations/1730000000000-Stateledger.ts
import type { MigrationInterface, QueryRunner } from "typeorm";
import { STATELEDGER_SCHEMA_STATEMENTS } from "@stateledger/typeorm";

export class Stateledger1730000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
      await queryRunner.query(stmt);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "stateledger_transitions"`);
  }
}
```

`STATELEDGER_SCHEMA_SQL` is the same DDL as one multi-statement script, for pasting into a migration body or applying with `psql`. Use `STATELEDGER_SCHEMA_STATEMENTS` when you are feeding a driver one statement at a time, which is what `queryRunner.query()` and `manager.query()` both do.

## Use it

```ts
import { DataSource } from "typeorm";
import { defineMachine } from "@stateledger/core";
import { createTypeormAdapter } from "@stateledger/typeorm";

const dataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [/* your entities; stateledger needs none */],
});
await dataSource.initialize();

const adapter = createTypeormAdapter(dataSource);

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
createTypeormAdapter(dataSource, {
  tableName: "stateledger_transitions",   // default; override for multi-tenant setups
  locking: "pessimistic",                 // default; use "optimistic" to skip pg_advisory_xact_lock
});
```

- **`pessimistic`** (default) uses `pg_advisory_xact_lock(hashtextextended(machine:subject, 0))` per transition. Concurrent writers wait their turn.
- **`optimistic`** skips the advisory lock and relies on the partial unique index on `most_recent`. Faster under low contention. Caller must catch `OptimisticConcurrencyError` and retry.

`tableName` must be a plain unqualified identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`) of at most 63 characters. It is interpolated into the SQL as a quoted identifier because Postgres does not accept a bound parameter in table position, and anything that would need escaping to be legal is rejected outright rather than escaped. The length bound is there because Postgres truncates an over-long identifier to 63 bytes instead of erroring, so two configured names sharing a 63-character prefix would silently resolve to the same physical table.

## Joining an existing transaction

Pass a transaction-scoped `EntityManager` in place of the `DataSource` and the adapter joins the transaction you already opened, instead of starting its own:

```ts
await dataSource.transaction(async (manager) => {
  await stripe.paymentIntents.create(/* ... */);     // your business logic
  const adapter = createTypeormAdapter(manager);     // joins the outer tx
  const machine = defineMachine({ /* ... */, adapter });
  await machine.transition("pay_123", "authorize");
});
```

This is the path most TypeORM and NestJS code will take, so it is worth knowing exactly what the adapter checks. A manager that is pinned to a `QueryRunner` with an active transaction is joined as-is. A `DataSource`, or a `DataSource`'s global `dataSource.manager`, has no transaction to join, so the adapter opens one.

In NestJS, build the adapter inside the request-scoped transaction rather than registering it as a singleton on the `DataSource`, so each transition participates in the caller's unit of work:

```ts
@Injectable()
export class PaymentsService {
  constructor(private readonly dataSource: DataSource) {}

  async authorize(id: string) {
    return this.dataSource.transaction(async (manager) => {
      const machine = defineMachine({
        /* ... */
        adapter: createTypeormAdapter(manager),
      });
      await machine.transition(id, "authorize");
    });
  }
}
```

### Why the transaction boundary matters

The advisory lock and the `INSERT` it protects have to run on the same database connection. `DataSource#query` without a query runner takes a connection out of the pool and releases it as soon as the statement finishes, so a `pg_advisory_xact_lock` acquired that way is gone before the next statement starts: the lock call succeeds, nothing is actually serialized, and the failure is invisible until two writers collide in production.

`transaction()` pins exactly one `QueryRunner` for the whole callback and calls back with an `EntityManager` bound to it, and `EntityManager#query` forwards that runner to the driver. The adapter hands that scoped manager out as its transaction handle and never falls back to the root client for a write, so the lock, the reads and the insert always share one connection. If you pass a manager you built yourself, make sure it came from a `transaction()` callback or from a `QueryRunner` you called `startTransaction()` on.

## Do I need `reflect-metadata`?

No. This adapter uses no decorators, no entity classes and no repositories, so there is nothing for the metadata reflection API to support, and the package never imports it.

TypeORM itself is a separate question, and the answer changed: in 1.x, `typeorm` requires `reflect-metadata` from its own entry point, so the `import "reflect-metadata"` line that every 0.3 tutorial opens with is no longer yours to write. On 0.3.x keep it at your application entry if you use decorated entities anywhere. Either way, it is not something you add on account of stateledger.

## Error translation

- A lost optimistic race is rejected by the partial unique index on `most_recent` and surfaces as `OptimisticConcurrencyError`. TypeORM wraps every failed statement in a `QueryFailedError`, so the adapter looks for SQLSTATE `23505` on the error itself, on `driverError` (where TypeORM keeps the untouched `pg` error) and on the `cause` / `original` slots other wrappers use.
- Everything else from the driver is wrapped in `AdapterError` with the original kept on `cause`.
- stateledger's own errors pass through untouched, so `catch (e) { if (e instanceof OptimisticConcurrencyError) ... }` works regardless of how deep the failure happened.

## Contract-conformant

Passes the same 13-spec [`@stateledger/core/contract-tests`](https://github.com/enowdivine/stateledger/blob/main/packages/core/src/contract-tests.ts) suite as `@stateledger/prisma` and `@stateledger/drizzle`: reads, appends, rollback, `most_recent` flip invariants, cross-subject independence, and time-travel semantics.

Run it locally:

```sh
pnpm --filter @stateledger/typeorm test:integration
```

Requires Docker (uses `testcontainers` to boot a real Postgres).

## License

MIT
