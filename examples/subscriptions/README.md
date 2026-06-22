# @stateledger-examples/subscriptions

End-to-end example: a subscription lifecycle state machine using
**optimistic concurrency**, plus a time-travel demo.

Companion to [`examples/payments/`](../payments). The payments example
runs in **pessimistic** mode (advisory locks per subject), which is the
right call when concurrent webhooks racing on the same record is a real
threat. Subscriptions don't have that problem — but a monthly billing run
does want to iterate thousands of subscriptions in parallel without
queuing. That's where optimistic mode shines.

## Scenarios

1. **Happy path** — `trial → active → past_due → active → canceled`. Standard subscription motion.
2. **Reactivation** — `canceled → reactivated → active`. Common conversion path that needs to be modeled as transitions, not a soft-delete.
3. **Time-travel** (new in v0.2.0) — `await sub.stateAt(timestamp)` returns the state the subscription was in at any past instant. Powers end-of-month billing ("charge everyone who was 'active' on the 1st"), support questions ("what state was this on April 3?"), compliance snapshots, post-mortems.
4. **Concurrent billing run** — 10 subscriptions transitioned in parallel under optimistic mode. No advisory locks acquired. Each writer races; the partial unique index on `most_recent` serializes them at write time.

## Quickstart

```bash
# 1. Start Postgres (port 5434, doesn't conflict with the payments example).
docker compose up -d

# 2. Set env.
cp .env.example .env

# 3. Install + push schema + add the partial unique index.
pnpm install
pnpm prisma db push
pnpm tsx src/apply-partial-index.ts

# 4. Run the demo.
pnpm simulate
```

Tear down with `docker compose down -v`.

## Why the partial unique index is load-bearing here

In the payments example, the partial unique index on `most_recent` is a
*defense in depth* — the advisory lock already prevents two writers from
racing on the same subject.

In this example there's **no advisory lock**. The partial unique index is
the only thing stopping two parallel writers from both inserting a new
`mostRecent = true` row for the same subscription. If you skip
`apply-partial-index.ts`, optimistic mode is unsafe.

## What time-travel actually does

```ts
await subscription.stateAt(new Date("2026-05-31T23:59:59Z"))
// → "active"   (the state it was in on the last day of May)
// → null       (if the subscription didn't exist yet)
```

Reads from the same history table the library already maintains. No
replay, no simulation — every transition is timestamped at write time, so
the answer is whichever row has the highest `sort_key` with
`created_at <= timestamp`.

A billing run becomes:

```ts
for (const sub of allSubs) {
  const machine = SubscriptionMachine.for(sub.id, { adapter });
  if ((await machine.stateAt(endOfMonth)) === "active") {
    await chargeCard(sub);
  }
}
```

No window-of-state race conditions. The decision is anchored to a fixed
moment, not "live state when the worker happens to run."

## Files worth reading

- [`src/machine.ts`](./src/machine.ts) — the `SubscriptionMachine` definition (5 states, 8 declared transitions, no guards or callbacks).
- [`src/simulate.ts`](./src/simulate.ts) — the four scenarios, including the time-travel demo.
- [`prisma/schema.prisma`](./prisma/schema.prisma) — Subscription model + the optional `StateledgerTransition` model for type-safe reads.
