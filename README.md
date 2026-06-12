# stateledger

> **A database-backed state machine for Node and TypeScript.** Transitions
> are persisted, audited, and concurrency-safe by default.

[![CI](https://github.com/enowdivine/stateledger/actions/workflows/ci.yml/badge.svg)](https://github.com/enowdivine/stateledger/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@stateledger/core?label=%40stateledger%2Fcore)](https://www.npmjs.com/package/@stateledger/core)

> **Status:** Early work-in-progress. Public API not yet stable. Do not use
> in production. Follow this repo for the first stable release.

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
| **Time-travel is impossible.** "What state was this in at 3am Tuesday?" | Reconstructable from history. `await machine.stateAt(timestamp)` (roadmapped). |
| **After-effects can leave you inconsistent.** State updated, then ledger write failed, now you have a charge with no ledger entry. | After-callbacks run in the same transaction as the row insert. Throw → both roll back. |

You could write all this yourself. Most teams have — it takes 2–4 weeks
the first time, breaks 3 months later under load, and gets rewritten.
That's why GoCardless built [Statesman](https://github.com/gocardless/statesman)
in Ruby after the third rewrite. Node didn't have an equivalent. That's
the gap.

## How it compares to XState

[XState](https://xstate.js.org) is excellent — for **in-memory** workflows
(form wizards, UI state, agent flows). It assumes your state lives in
memory and you bolt on persistence yourself.

`stateledger` assumes **the database IS the state** from the start.
Different problem, different tool.

## Example (preview — not yet shippable)

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
      await ctx.tx.ledgerEntry.create({ ... });
    },
  },
} as const);

const machine = PaymentMachine.for(payment.id, {
  adapter: createPrismaAdapter(prisma),
  actor: { id: "u-42", type: "USER" },
});

await machine.transitionTo("pending");      // bootstrap
await machine.transitionTo("authorized");   // typed, validated, locked, audited
await machine.transitionTo("captured");
await machine.history();                    // full timeline as typed rows
```

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
| [`@stateledger/core`](./packages/core) | Logic, types, `defineMachine`, the `Adapter` interface. Zero runtime deps. | Placeholder published |
| [`@stateledger/memory`](./packages/memory) | In-memory adapter. Great for tests + hello-world demos. | Placeholder published |
| [`@stateledger/prisma`](./packages/prisma) | Prisma adapter (Postgres). MVP target. | In design |
| `@stateledger/drizzle` | Drizzle adapter. Roadmapped for v1.0. | Not started |
| `@stateledger/outbox` | Transactional outbox helper for side effects. Roadmapped for v1.0. | Not started |

> Note: the package previously called `@stateledger/testing` (internal) has been
> renamed to `@stateledger/memory` and is now public. The npm scope is bound,
> so the rename is final.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ and pnpm 9+.

## License

MIT — see [LICENSE](./LICENSE).
