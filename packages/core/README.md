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
| **Time-travel is impossible.** "What state was this in at 3am Tuesday?" | Reconstructable from history. `await machine.stateAt(timestamp)` (roadmapped). |
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

See the main [repo README](https://github.com/enowdivine/stateledger) for
a full quickstart and the [`examples/payments/`](https://github.com/enowdivine/stateledger/tree/main/examples/payments)
directory for a runnable end-to-end demo.

## License

MIT
