# v1.0.0 — Production-ready + `@stateledger/outbox`

**stateledger is now v1.0.** The core state-machine engine, the two
persistence adapters, and the new transactional-outbox helper are all
tagged stable and are being used in production. If you were waiting for a
1.0 signal before adopting, this is it.

The headline addition is `@stateledger/outbox` — the last piece of the
"safe side effects" story that has been on the roadmap since v0.1.

---

## What's new

### `@stateledger/outbox` — atomic side effects

State machines can safely update your database. But most real apps also
need to do things **outside** the database: call Stripe, send an email,
publish to Kafka, hit an SMS gateway. Do the side effect before the tx
commits and you risk phantom actions; do it after and you risk state
drift when the process crashes.

`@stateledger/outbox` implements the transactional-outbox pattern
end-to-end:

```ts
// Inside your after-callback | same tx as the transition write:
"after:authorized->captured": async ({ tx, subject }) => {
  await enqueue(tx, {
    kind: "stripe.capture",
    payload: { paymentIntentId: subject.stripeId, amount: subject.amount },
  });
},
```

```ts
// A separate worker process delivers with retries + DLQ:
const worker = createWorker({
  client: prisma,
  handlers: {
    "stripe.capture": async ({ paymentIntentId, amount }) => {
      await stripe.paymentIntents.capture(paymentIntentId, {
        amount_to_capture: amount,
      });
    },
  },
});
worker.start();
```

**What ships:**

- `enqueue(tx, ...)` — inserts an outbox row inside the caller's tx. Row
  commits atomically with the transition write, or rolls back with it.
- `enqueueBatch(tx, ...)` — same contract, one SQL round-trip for N rows.
- `createWorker({ client, handlers, ... })` — poll → claim
  (`FOR UPDATE SKIP LOCKED`) → dispatch → retry with exponential backoff →
  dead-letter after `maxAttempts`.
- `WorkerEvent` observer: hook into `claimed`, `delivered`, `rescheduled`,
  `dead-lettered`, `unknown-kind`, `worker-error` for logging + metrics.
- **Regional routing** — tag rows with a `region`, run one worker per
  region. Rows with `region = NULL` are picked up by any worker.
- **Stuck-row reclaim** — a worker that crashed mid-dispatch is
  auto-recovered by the next worker after 5 minutes.
- **Graceful stop** — `worker.stop()` awaits the in-flight dispatch
  before resolving, so no rows are stranded in `processing`.
- **Structural tx typing** — works with Prisma, Drizzle, or a raw `pg`
  shim (anything with `$queryRawUnsafe` / `$executeRawUnsafe`).

**26 integration tests** run against a real Postgres via testcontainers
and cover the full invariant surface: atomicity, retry with backoff, DLQ,
concurrency (multiple workers claim different rows with zero
double-dispatch), stuck-row reclaim, and graceful stop.

Full API + failure-mode reference: <https://stateledger.saassimplified.net/docs/outbox>

---

## Everything else

- `@stateledger/core@1.0.0` — no API changes. Version bumped to signal
  the stable tag.
- `@stateledger/prisma@1.0.0` — no API changes. Now paired with the
  outbox helper in the docs and payments example.
- `@stateledger/drizzle@1.0.0` — first `latest` publish (was
  `awaiting first release` in v0.3 NOTES). No API changes since the
  earlier build.
- `@stateledger/memory@1.0.0` — no changes; version-bumped for parity.

The **payments example** in the monorepo now runs a sixth scenario
demonstrating the outbox end-to-end — the after-callback enqueues a
receipt-email intent alongside the ledger write, and a `createWorker`
runs in-process to dispatch it. Reads well as a copy-paste starter.

---

## Migration from 0.x

No breaking API changes. `pnpm add` the new package versions and you're
current. If you want to adopt the outbox helper, apply its schema once:

```ts
import { OUTBOX_SCHEMA_STATEMENTS } from "@stateledger/outbox";
import { prisma } from "./prisma";

for (const stmt of OUTBOX_SCHEMA_STATEMENTS) {
  await prisma.$executeRawUnsafe(stmt);
}
```

Then start enqueuing from inside your after-callbacks. See the
[outbox guide](https://stateledger.saassimplified.net/docs/outbox) for
the full walkthrough.

---

## Housekeeping

- **Changesets** — this release was version-bumped manually (before the
  changesets workflow was properly wired). All 1.0.1+ releases will use
  the standard `pnpm changeset` flow with per-package `CHANGELOG.md`
  files.
- **Docs site** — `stateledger.saassimplified.net` refreshed with the
  outbox story: hero mention, feature card, dedicated `/docs/outbox`
  page, updated FAQ, examples grid linking to the payments +
  subscriptions demos.

---

## Thanks + next steps

If stateledger has been useful to you, a GitHub star is genuinely
motivating for OSS work you don't get paid for. If it's not useful yet,
open an [issue](https://github.com/enowdivine/stateledger/issues) and
tell me what's missing — most of the roadmap comes from real users
asking real questions.

Roadmap for the next release cycle lives in
[`NOTES.md`](https://github.com/enowdivine/stateledger/blob/main/NOTES.md).
Multi-machine coordination and a CI version-guard are the two ideas most
often floated for a paid Pro tier — feedback welcome.
