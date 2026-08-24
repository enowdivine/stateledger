# @stateledger-examples/payments

End-to-end example: a payments state machine backed by Postgres via
[`@stateledger/prisma`](../../packages/prisma) and
[`@stateledger/outbox`](../../packages/outbox).

Walks through six scenarios that exercise the library's value props:

1. **Happy path + transactional after-callback** — `pending` → `authorized`
   → `captured`, with the full timeline persisted in
   `stateledger_transitions`. Capturing also writes a `ledger_entries` row
   AND enqueues a `receipt.email` outbox note in the **same** transaction.
   If any of the writes throw, everything rolls back — no "captured
   payment with no ledger entry" and no "captured payment with a rogue
   email queued but no state change" can land in the DB.
2. **Invalid transition** — trying to jump from `pending` directly to
   `settled` throws `InvalidTransition` because no such transition was
   declared.
3. **Guard rejection** — a zero-amount payment can't be authorized
   (declared guard rejects it as `GuardRejected`).
4. **Concurrent webhooks** — two parallel attempts to authorize the same
   payment. Pessimistic advisory locking serializes them; the second one
   sees the payment is already authorized and is rejected. No
   double-authorize.
5. **Outbox delivery** — spins up an in-process `createWorker`, drains the
   pending `receipt.email` rows, and shows the worker events (`delivered`,
   `dead-lettered`). Same worker code you'd run under pm2/systemd in prod.

## Quickstart

```bash
# 1. Start Postgres (port 5433, so it doesn't fight whatever you have on 5432).
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

Tear down with `docker compose down -v` when you're done.

## What you'll see

```
=== @stateledger/prisma — payments example ===

[1] Happy path: pending → authorized → captured (and history is persisted)
  history:
    <initial>    → pending       USER:u-42  @ 2026-06-12T…
    pending      → authorized    USER:u-42  @ 2026-06-12T…
    authorized   → captured      USER:u-42  @ 2026-06-12T…
  ledger: 1 entry written transactionally with the capture (kind=CAPTURE)

[2] Invalid transition: pending → settled (skipping authorized + captured)
  rejected with InvalidTransition: [payment] …: no transition declared from "pending" to "settled".

[3] Guard rejection: a zero-amount payment can't be authorized
  rejected with GuardRejected: [payment] …: guard rejected transition "pending" → "authorized".

[4] Concurrent webhooks: two requests both try to authorize the same payment
  1 succeeded, 1 rejected — no double-authorize possible
  history (still a single authorization):
    <initial>    → pending       SYSTEM:system     @ …
    pending      → authorized    WEBHOOK:webhook-A @ …
```

The exact actor that wins the race is non-deterministic — that's the point.
The library guarantees that **at most one** does.

## Files worth reading

- [`src/machine.ts`](./src/machine.ts) — the `PaymentMachine` definition.
  Declared states, transitions, a guard, and an after-callback that
  shares the transition's transaction.
- [`src/simulate.ts`](./src/simulate.ts) — the runnable scenarios.
- [`prisma/schema.prisma`](./prisma/schema.prisma) — Payment + LedgerEntry +
  StateledgerTransition models (the last one is optional for the adapter,
  useful for type-safe reads from app code).
- [`src/apply-partial-index.ts`](./src/apply-partial-index.ts) — adds the
  partial unique index Prisma's DSL can't express.
