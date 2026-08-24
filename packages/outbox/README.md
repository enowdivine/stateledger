# @stateledger/outbox

> Transactional outbox for [stateledger](https://github.com/enowdivine/stateledger).
> Safe side effects that survive rollbacks, restarts, and third-party downtime.

---

## The problem

Your state machine transitions safely inside a transaction — but real apps
also need to do things **outside** the database: call Stripe, send an email,
publish to Kafka, hit an SMS gateway.

If you do the side effect **before** the transaction commits, you can end up
with a phantom action when the tx rolls back. If you do it **after**, you
can end up with a state change that has no matching side effect when your
process crashes at the wrong moment.

Either way, state and side effects drift.

## The pattern

Don't do the side effect directly. Write a **note** inside the same
transaction as your state change, then let a background worker read the
notes and dispatch the actual work.

```
BEGIN
  INSERT INTO stateledger_transitions ...   -- state row
  INSERT INTO stateledger_outbox      ...   -- "call Stripe" note
COMMIT
```

Both rows commit atomically. A worker later reads pending notes, calls
Stripe, and marks them delivered. If the worker crashes mid-call, the row
stays claimed until it's reclaimed by the next worker and retried.

At-least-once delivery + your own idempotency on the receiving side =
provably safe.

---

## Install

```bash
pnpm add @stateledger/outbox
```

Works with `@stateledger/prisma` or `@stateledger/drizzle`, or directly on
top of `pg` — anything that exposes `$queryRawUnsafe` /
`$executeRawUnsafe` satisfies the `OutboxTx` interface.

## Schema

Apply the schema once, from a migration or an idempotent bootstrap script.

```ts
import { OUTBOX_SCHEMA_STATEMENTS } from "@stateledger/outbox";
import { prisma } from "./db";

for (const stmt of OUTBOX_SCHEMA_STATEMENTS) {
  await prisma.$executeRawUnsafe(stmt);
}
```

Or use `OUTBOX_SCHEMA_SQL` as the body of a Prisma migration
(`migration.sql`).

---

## Enqueue

Call `enqueue` from inside a stateledger `after:from->to` callback. The
`tx` handle you receive is the same one the transition write uses, so the
note commits atomically with the state row.

```ts
import { defineMachine } from "@stateledger/core";
import { createPrismaAdapter } from "@stateledger/prisma";
import { enqueue } from "@stateledger/outbox";

const paymentMachine = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "failed"] as const,
  initialState: "pending",
  transitions: [
    { from: "pending",    to: "authorized" },
    { from: "authorized", to: "captured"   },
    { from: "authorized", to: "failed"     },
  ] as const,
  callbacks: {
    "after:authorized->captured": async ({ tx, subject }) => {
      await enqueue(tx, {
        kind: "stripe.capture",
        payload: {
          paymentIntentId: (subject as { stripeId: string }).stripeId,
          amount: (subject as { amount: number }).amount,
        },
      });
    },
  },
});
```

If the transition rolls back, the outbox note rolls back too. If the
transition commits, the note is there for the worker to pick up.

### Options

```ts
await enqueue(tx, {
  kind: "sms.send",
  payload: { phone: "+237...", body: "..." },
  region: "af-central",       // optional | see "Regional workers" below
  availableAt: new Date(Date.now() + 60_000), // delay 1 minute
});
```

### Batching

```ts
import { enqueueBatch } from "@stateledger/outbox";

await enqueueBatch(tx, [
  { kind: "receipt.email",   payload: { userId } },
  { kind: "analytics.event", payload: { event: "checkout_complete" } },
]);
```

Single SQL round-trip. Same atomicity contract as `enqueue`.

---

## Worker

The worker is a small Node process you run alongside your API. It polls the
outbox table, claims one row at a time, dispatches it through your handler
registry, and marks it delivered — or reschedules with backoff on failure.

Put this in a standalone file and run it (pm2, systemd, Fly, Kubernetes,
your choice):

```ts
// worker.ts
import { createWorker } from "@stateledger/outbox";
import { PrismaClient } from "@prisma/client";
import { stripe, mailer } from "./services";

const prisma = new PrismaClient();

const worker = createWorker({
  client: prisma,
  handlers: {
    "stripe.capture": async (payload: { paymentIntentId: string; amount: number }) => {
      await stripe.paymentIntents.capture(payload.paymentIntentId, {
        amount_to_capture: payload.amount,
      });
    },
    "receipt.email": async (payload: { userId: string }) => {
      await mailer.send({ template: "receipt", userId: payload.userId });
    },
  },
  onEvent: (event) => {
    // Logging + metrics hook. Fires for: claimed, delivered, rescheduled,
    // dead-lettered, unknown-kind, worker-error.
    if (event.type === "dead-lettered") {
      console.error("[outbox] DLQ:", event.record.kind, event.record.id, event.error);
    }
  },
});

worker.start();

// Graceful shutdown | wait for the in-flight dispatch (if any) to settle.
process.on("SIGTERM", async () => {
  await worker.stop();
  await prisma.$disconnect();
  process.exit(0);
});
```

### Config reference

| Option | Default | What it does |
|---|---|---|
| `client` | — required — | Postgres client (Prisma, Drizzle, pg-shim). |
| `handlers` | — required — | Registry of async functions keyed by `kind`. |
| `region` | `undefined` | Only claim rows whose `region` matches (or `NULL`). |
| `workerId` | `${hostname}:${pid}:${uuid8}` | Written to `worker_id` on claim, for debugging. |
| `pollIntervalMs` | `500` | Wait this long between empty polls. |
| `maxAttempts` | `5` | Attempts before a row is dead-lettered. |
| `backoffMs(attempt)` | `1s, 2s, 4s, 8s, 16s` capped at 5min | Delay before retry. |
| `onEvent(event)` | `undefined` | Observer for `claimed` / `delivered` / `rescheduled` / `dead-lettered` / `unknown-kind` / `worker-error`. |

### Handler contract

Handlers **must** be idempotent — outbox delivery is at-least-once. If a
worker crashes between "call Stripe" and "mark delivered," another worker
will retry the same row later.

- **Return normally** to signal success. The row is marked `delivered`.
- **Throw** to signal failure. The worker increments `attempts` and either
  reschedules with backoff or dead-letters based on `maxAttempts`.

### Running multiple workers

Just run more processes. `FOR UPDATE SKIP LOCKED` in the claim query
guarantees each row is dispatched by at most one worker at a time. Scale
horizontally on the same DB — no coordinator, no leader election.

### Regional workers

If you're calling regionally-hosted services (MTN Mobile Money in Cameroon,
Twilio in the US, Stripe EU in Europe), tag each note with a `region` and
run a worker per region:

```ts
// Cameroon region
createWorker({ client: prisma, region: "af-central", handlers: { "mtn.charge": ... } }).start();

// EU region
createWorker({ client: prisma, region: "eu-west", handlers: { "stripe.capture": ... } }).start();
```

Each worker only claims its own region's rows. Rows with `region = NULL` are
picked up by any worker (default routing).

---

## Failure modes

| Scenario | What happens |
|---|---|
| External API returns 500 | Handler throws → `attempts++` → reschedule with backoff. |
| Worker process crashes mid-dispatch | Row stays in `processing`; next worker reclaims after 5 min (see `reclaimStuckRows`). |
| Payload is invalid | Handler throws → treated as a normal failure → dead-letters after `maxAttempts`. |
| No handler for `kind` | Row is dead-lettered immediately (retrying can't fix missing code). |
| Business tx rolls back | Outbox row rolls back too — no orphan intent. |

The dead-letter queue is just rows with `status = 'failed'`. Query them
however you like:

```sql
SELECT id, kind, last_error, created_at
FROM stateledger_outbox
WHERE status = 'failed'
ORDER BY created_at DESC;
```

Fix the underlying issue, then re-queue by updating the row back to
`pending` and resetting `attempts`:

```sql
UPDATE stateledger_outbox
SET status = 'pending', attempts = 0, last_error = NULL, available_at = NOW()
WHERE id = '...';
```

---

## License

MIT
