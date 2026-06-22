# stateledger

> **A database-backed state machine for Node and TypeScript.** Transitions
> are persisted, audited, and concurrency-safe by default.

[![CI](https://github.com/enowdivine/stateledger/actions/workflows/ci.yml/badge.svg)](https://github.com/enowdivine/stateledger/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@stateledger/core?label=%40stateledger%2Fcore)](https://www.npmjs.com/package/@stateledger/core)
[![npm](https://img.shields.io/npm/v/@stateledger/prisma?label=%40stateledger%2Fprisma)](https://www.npmjs.com/package/@stateledger/prisma)

The boring, audit-friendly kind of state machine — not the blockchain kind.
Designed for payments, fintech, and any backend where you need to know
exactly when each business record moved between states, who triggered it,
and that no two processes can transition it at the same time.

---

## Why this exists

Most of us have written code like this:

```ts
class Payment {
  state: "pending" | "authorized" | "captured" = "pending";

  authorize() {
    if (this.state !== "pending") throw new Error("Cannot authorize");
    this.state = "authorized";
  }
}
```

It works. Then you ship to production, and discover:

| What breaks in production | What `stateledger` does |
|---|---|
| **Restart kills state.** It lived in memory. | Every transition is a row in your DB. Survives restarts, deploys, crashes. |
| **Concurrent webhooks double-charge.** Two requests both pass the `if` check and both mutate state. | Acquires a lock on `(machine, subjectId)`. Concurrent transitions serialize cleanly. |
| **No record of who/when/why.** Customer asks "when did my refund fail?" — no answer. | Every row has an actor, timestamp, and free-form metadata. `await machine.history()` returns the full timeline. |
| **Compliance can't audit.** Regulators ask "show every state change in Q3, who triggered it." | It's a SQL query against the `transitions` table. |
| **Bugs corrupt state silently.** A bad code path writes "pending" → "settled" without going through "authorized". | Validates against declared transitions on every write. Throws `InvalidTransition` immediately. |
| **Time-travel is impossible.** "What state was this in at 3am Tuesday?" | `await machine.stateAt(timestamp)` returns the state that was current at any past instant. |
| **After-effects can leave you inconsistent.** State updated, then ledger write failed, now you have a charge with no ledger entry. | After-callbacks run in the same transaction as the row insert. Throw → both roll back. |

You could write all this yourself. Most teams have — it takes 2–4 weeks
the first time, breaks 3 months later under load, and gets rewritten.
That's why GoCardless built [Statesman](https://github.com/gocardless/statesman)
in Ruby after the third rewrite. Node didn't have an equivalent. That's
the gap.

## Quickstart

```bash
pnpm add @stateledger/core @stateledger/prisma @prisma/client
```

```ts
import { defineMachine } from "@stateledger/core";
import { createPrismaAdapter } from "@stateledger/prisma";

const PaymentMachine = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "settled", "failed"],
  initialState: "pending",
  transitions: [
    { from: "pending",    to: "authorized" },
    { from: "pending",    to: "failed" },
    { from: "authorized", to: "captured" },
    { from: "captured",   to: "settled" },
  ],
  callbacks: {
    "after:authorized->captured": async (ctx) => {
      // Runs in the same DB transaction as the transition.
      // Throw here, and the transition rolls back.
      await ctx.tx.ledgerEntry.create({ data: { ... } });
    },
  },
} as const);

const machine = PaymentMachine.for(payment.id, {
  adapter: createPrismaAdapter(prisma),
  actor: { id: "u-42", type: "USER" },
});

await machine.transitionTo("pending");      // bootstrap
await machine.transitionTo("authorized");   // typed, validated, locked, audited
await machine.transitionTo("captured");     // ledger entry written atomically
await machine.history();                    // full timeline as typed rows
```

## Time-travel — `stateAt(timestamp)`

Reconstruct the state at any past instant from the persisted history. One
SQL query, no replay or simulation. Powers customer-support answers,
end-of-month billing snapshots, compliance reports, and post-mortems.

```ts
// "What state was this payment in at 3am last Tuesday?"
const state = await machine.stateAt(new Date("2026-06-17T03:00:00Z"));
// → "authorized"   (or whichever state was current then)
// → null            (if the subject didn't exist yet)
```

Practical example — a billing job that charges everyone whose subscription
was `active` at the moment the month closed:

```ts
const endOfMonth = new Date("2026-06-30T23:59:59Z");
for (const sub of subscriptions) {
  const m = SubscriptionMachine.for(sub.id, { adapter });
  if ((await m.stateAt(endOfMonth)) === "active") {
    await chargeCard(sub);
  }
}
```

The decision is anchored to a fixed moment — no race condition between
"the worker started" and "live state when it actually queried."

> **See it run:**
> - [`examples/payments/`](./examples/payments) — five scenarios against
>   real Postgres in Docker. Pessimistic locking, transactional callbacks,
>   a concurrent-webhook race. `pnpm db:setup && pnpm simulate`.
> - [`examples/subscriptions/`](./examples/subscriptions) — subscription
>   lifecycle using **optimistic concurrency**, plus a time-travel demo
>   and a 10-subscriptions-in-parallel billing run.

## Where this fits

Built for **payments and fintech**, where a missed state change is a
regulatory event. The API choices reflect that origin: pessimistic locking
by default, transactional callbacks, an immutable audit trail.

The abstraction generalizes naturally. Any business record that moves
between named stages and needs an audit trail benefits from the same
treatment:

- **Orders** — `cart → submitted → paid → shipped → delivered`
- **Subscriptions** — `trial → active → past_due → canceled`
- **KYC / onboarding** — `submitted → reviewing → approved` (or `rejected`)
- **Document workflows** — `draft → in_review → approved → archived`
- **Loan applications** — `submitted → underwriting → approved → funded`
- **Support tickets** — `new → assigned → in_progress → resolved`

Same library, same patterns, different rulebook. The library is
deliberately "dumb" about what the states mean — that semantic layer is
yours.

## Packages

| Package | What | Status |
|---|---|---|
| [`@stateledger/core`](./packages/core) | Logic, types, `defineMachine`, the `Adapter` interface. Zero runtime deps. | Published |
| [`@stateledger/memory`](./packages/memory) | In-memory adapter. Great for tests + hello-world demos. | Published |
| [`@stateledger/prisma`](./packages/prisma) | Prisma + Postgres adapter. Pessimistic locks by default, optimistic opt-in. | Published |
| `@stateledger/drizzle` | Drizzle adapter. Roadmapped for v1.0. | Not started |
| `@stateledger/outbox` | Transactional outbox helper for side effects. Roadmapped for v1.0. | Not started |

## Development

```bash
pnpm install
pnpm build
pnpm test              # unit + in-memory contract tests
pnpm --filter @stateledger/prisma test:integration   # real Postgres via testcontainers (needs Docker)
```

Requires Node 20+ and pnpm 9+.

## License

MIT — see [LICENSE](./LICENSE).
