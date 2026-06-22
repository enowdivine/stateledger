# @stateledger/core

[![npm](https://img.shields.io/npm/v/@stateledger/core?label=%40stateledger%2Fcore)](https://www.npmjs.com/package/@stateledger/core)

A **database-backed state machine** for Node and TypeScript. The boring,
audit-friendly kind, not the blockchain kind. This package holds the
core logic — `defineMachine`, the `Adapter` interface, the type system.
Bring your own adapter:
[`@stateledger/prisma`](https://www.npmjs.com/package/@stateledger/prisma)
for Postgres, or
[`@stateledger/memory`](https://www.npmjs.com/package/@stateledger/memory)
for tests.

## What you'd write yourself vs. what `stateledger` does

If you've ever rolled this in production, you've written something like:

```ts
class Payment {
  state: "pending" | "authorized" | "captured" = "pending";

  authorize() {
    if (this.state !== "pending") throw new Error("Cannot authorize");
    this.state = "authorized";
  }
}
```

Works fine. Until you ship it. Then you discover:

| What breaks in production | What `stateledger` does |
|---|---|
| **Restart kills state.** It lived in memory. | Every transition is a row in your DB. Survives restarts, deploys, crashes. |
| **Concurrent webhooks double-charge.** Two requests both pass the `if` check and both mutate state. | Acquires a lock on `(machine, subjectId)`. Concurrent transitions serialize cleanly. |
| **No record of who/when/why.** Customer asks "when did my refund fail?" — no answer. | Every row has an actor, timestamp, and free-form metadata. `await machine.history()` returns the full timeline. |
| **Compliance can't audit.** Regulators ask "show every state change in Q3, who triggered it." | It's a SQL query against the `transitions` table. |
| **Bugs corrupt state silently.** A bad code path writes "pending" → "settled" without going through "authorized". | Validates against declared transitions on every write. Throws `InvalidTransition` immediately. |
| **Time-travel is impossible.** "What state was this in at 3am Tuesday?" | `await machine.stateAt(timestamp)` returns the state that was current at any past instant. |
| **After-effects can leave you inconsistent.** State updated, then ledger write failed, now you have a charge with no ledger entry. | After-callbacks run in the same transaction as the row insert. Throw → both roll back. |

You could write all this yourself. Most teams have — it takes 2–4 weeks the
first time, breaks 3 months later under load, and gets rewritten. That's why
GoCardless built [Statesman](https://github.com/gocardless/statesman) in Ruby
after the third rewrite. Node didn't have an equivalent. That's the gap.

## Where this fits

Built for payments and fintech, where a missed state change is a regulatory
event. The API choices reflect that — pessimistic locking by default,
transactional callbacks, immutable audit trail.

The abstraction generalizes. Anywhere a business record moves between named
stages and needs an audit trail: orders, subscriptions, KYC checks,
document approval, loan applications, support tickets. Same library, same
patterns, different rulebook.

## Install

```bash
pnpm add @stateledger/core @stateledger/prisma @prisma/client
```

## What you get

```ts
import { defineMachine } from "@stateledger/core";
import { createPrismaAdapter } from "@stateledger/prisma";

const PaymentMachine = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "failed"],
  initialState: "pending",
  transitions: [
    { from: "pending", to: "authorized" },
    { from: "authorized", to: "captured" },
  ],
} as const);

const m = PaymentMachine.for(payment.id, {
  adapter: createPrismaAdapter(prisma),
  actor: { id: "u-42", type: "USER" },
});

await m.transitionTo("pending");       // bootstrap
await m.transitionTo("authorized");    // typed, validated, locked, audited
await m.history();                     // every transition, oldest first
await m.readCurrent();                 // most recent transition row
await m.stateAt(new Date("…"));        // state at any past instant
```

## Time-travel — `stateAt(timestamp)`

Returns the state the subject was in at any past instant. One SQL query
against the existing history table — no replay, no simulation.

```ts
await m.stateAt(new Date("2026-06-17T03:00:00Z"))  // → "authorized"
await m.stateAt(new Date(0))                        // → null (didn't exist yet)
```

Use it for:
- **Customer support** — "what state was this in when the issue happened?"
- **Billing snapshots** — "charge everyone who was `active` on the 1st"
- **Compliance** — end-of-quarter state snapshots without custom SQL
- **Post-mortems** — pin down the exact state at the moment an error fired

If you need a cutoff that lands "right after" a specific transition,
anchor to the row's own `createdAt` instead of `new Date()` to avoid
clock skew between your app and the database:

```ts
const row = await m.transitionTo("active");
const justAfter = new Date(row.createdAt.getTime() + 1);
await m.stateAt(justAfter);   // → "active", reliably
```

See the main [repo README](https://github.com/enowdivine/stateledger) for
a full quickstart and [`examples/payments/`](https://github.com/enowdivine/stateledger/tree/main/examples/payments)
+ [`examples/subscriptions/`](https://github.com/enowdivine/stateledger/tree/main/examples/subscriptions)
for runnable end-to-end demos.

## License

MIT
