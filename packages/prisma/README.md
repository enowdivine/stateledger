# @stateledger/prisma

> Prisma + Postgres adapter for [stateledger](https://github.com/enowdivine/stateledger).

[![npm](https://img.shields.io/npm/v/@stateledger/prisma?label=%40stateledger%2Fprisma)](https://www.npmjs.com/package/@stateledger/prisma)

Wires [`@stateledger/core`](https://www.npmjs.com/package/@stateledger/core)
to Postgres via Prisma. Pessimistic concurrency by default (advisory
locks), transactional after-callbacks, immutable audit trail.

## Install

```bash
pnpm add @stateledger/core @stateledger/prisma
# Peer:
pnpm add @prisma/client
```

Postgres only. The adapter relies on `pg_advisory_xact_lock` and a partial
unique index — both Postgres-specific.

## Add the schema

The adapter writes to a single table, `stateledger_transitions`. Add it
via a Prisma migration:

```bash
pnpm prisma migrate dev --create-only --name add_stateledger
```

Then paste the contents of [`STATELEDGER_SCHEMA_SQL`](./src/schema-sql.ts)
into the generated `migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "stateledger_transitions" (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  machine          TEXT         NOT NULL,
  subject_id       TEXT         NOT NULL,
  from_state       TEXT,
  to_state         TEXT         NOT NULL,
  sort_key         INTEGER      NOT NULL,
  most_recent      BOOLEAN      NOT NULL DEFAULT TRUE,
  actor_id         TEXT,
  actor_type       TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  machine_version  INTEGER      NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "stateledger_transitions_subject_sort_key"
  ON "stateledger_transitions" (machine, subject_id, sort_key);

-- Partial unique: exactly one mostRecent row per subject. Load-bearing.
CREATE UNIQUE INDEX IF NOT EXISTS "stateledger_transitions_one_most_recent"
  ON "stateledger_transitions" (machine, subject_id)
  WHERE most_recent = TRUE;

CREATE INDEX IF NOT EXISTS "stateledger_transitions_history"
  ON "stateledger_transitions" (machine, subject_id, sort_key DESC);
```

Then `pnpm prisma migrate dev` to apply.

> **Why raw SQL and not a Prisma model?** Prisma's schema language can't
> express the partial unique index on `most_recent`, and that index is the
> correctness invariant the library leans on. Shipping the schema as raw
> SQL keeps the storage layer identical to the future Drizzle and TypeORM
> adapters.

If you want a Prisma model on top for type-safe reads from your own code,
you can add one alongside — see the [test schema](./test/prisma/schema.prisma)
for an example. It's optional.

> **Gotcha if you add the model.** Use
> `@id @default(dbgenerated("gen_random_uuid()")) @db.Uuid` on the `id`
> field — NOT `@default(uuid())`. The adapter writes rows via raw `INSERT`,
> bypassing Prisma's client-side UUID generator. The default has to live
> in the Postgres column, not on Prisma's side.

## Use it

```ts
import { defineMachine } from "@stateledger/core";
import { createPrismaAdapter } from "@stateledger/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const adapter = createPrismaAdapter(prisma);

const PaymentMachine = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "failed"],
  initialState: "pending",
  transitions: [
    { from: "pending",    to: "authorized" },
    { from: "pending",    to: "failed" },
    { from: "authorized", to: "captured" },
  ],
} as const);

const machine = PaymentMachine.for(paymentId, {
  adapter,
  actor: { id: userId, type: "USER" },
});

await machine.transitionTo("pending");      // bootstrap
await machine.transitionTo("authorized");   // locked, validated, audited
await machine.history();                    // full timeline
await machine.stateAt(new Date("2026-06-17T03:00:00Z")); // time-travel
```

## Time-travel — `stateAt(timestamp)`

The Prisma adapter implements `stateAt()` with a single SQL query:

```sql
SELECT * FROM stateledger_transitions
 WHERE machine = $1 AND subject_id = $2 AND created_at <= $3
 ORDER BY sort_key DESC
 LIMIT 1
```

Returns the row that was current at the cutoff, or `null` if the subject
didn't exist yet. See the [core README](https://www.npmjs.com/package/@stateledger/core)
for the full usage story; this adapter just executes the query.

## Joining an existing transaction

If you're already inside a `prisma.$transaction(...)`, hand the
`TransactionClient` to the adapter and the transition will join that
transaction instead of opening a new one:

```ts
await prisma.$transaction(async (tx) => {
  await tx.invoice.create({ data: { ... } });

  const adapter = createPrismaAdapter(tx);
  const machine = PaymentMachine.for(paymentId, { adapter, actor });
  await machine.transitionTo("authorized");

  // Both the invoice insert and the transition roll back together if
  // anything throws inside this block.
});
```

## Options

```ts
createPrismaAdapter(prisma, {
  // Postgres table name. Override if you've namespaced it. Must be a
  // valid SQL identifier (letters, digits, underscores).
  tableName: "stateledger_transitions",

  // "pessimistic" (default) takes a per-(machine, subjectId) advisory
  // lock — concurrent writers wait their turn.
  //
  // "optimistic" skips the lock and relies on the partial unique index
  // to detect lost races. The library raises `OptimisticConcurrencyError`
  // on the loser; the caller is expected to retry.
  locking: "pessimistic",
});
```

## Locking model

By default, every transition takes a Postgres advisory lock keyed on
`(machine, subjectId)` (`pg_advisory_xact_lock(hashtextextended(...))`).
The lock is bound to the transaction's lifetime — it releases
automatically on commit or rollback. There's no separate `releaseLock`
call and no shared state to clean up if your process dies mid-transaction.

If you need to scale writes higher than one-per-subject at a time and can
tolerate retries, switch to `locking: "optimistic"`. The partial unique
index on `most_recent` will reject the loser of any race with a
constraint violation, which the adapter surfaces as the library's
`OptimisticConcurrencyError`. Catch and retry from your application
code.

## Development

```bash
# Install deps + generate test client
pnpm install
pnpm --filter @stateledger/prisma prisma:generate

# Unit tests (no Docker required)
pnpm --filter @stateledger/prisma test

# Integration tests (boots a real Postgres in Docker via testcontainers)
pnpm --filter @stateledger/prisma test:integration
```

## License

MIT
