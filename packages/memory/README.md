# @stateledger/memory

> In-memory adapter for [stateledger](https://github.com/enowdivine/stateledger).
> Use it for tests, hello-world demos, and prototyping — **not production**.
> State is lost on process exit.

> ⚠️ **Placeholder release.** This `experimental` tag exists alongside the
> rest of the `@stateledger/*` scope while the API stabilizes. The first
> real release will publish to the `latest` tag.

---

## Install

```
pnpm add @stateledger/core @stateledger/memory
```

## Use

```ts
import { defineMachine } from "@stateledger/core";
import { InMemoryAdapter } from "@stateledger/memory";

const PaymentMachine = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "settled"],
  initialState: "pending",
  transitions: [
    { from: "pending",    to: "authorized" },
    { from: "authorized", to: "captured" },
    { from: "captured",   to: "settled" },
  ],
} as const);

const adapter = new InMemoryAdapter();
const machine = PaymentMachine.for("payment-1", { adapter });

await machine.transitionTo("pending");      // bootstrap
await machine.transitionTo("authorized");
await machine.transitionTo("captured");

console.log(await machine.history());
// [
//   { fromState: null,         toState: "pending",    sortKey: 1, ... },
//   { fromState: "pending",    toState: "authorized", sortKey: 2, ... },
//   { fromState: "authorized", toState: "captured",   sortKey: 3, ... },
// ]
```

## When to use this

- **Unit tests** in user code. Spin up a fresh adapter per test, no DB setup.
- **Hello-world demos** in documentation or tutorials.
- **Prototyping** an API design before wiring up real persistence.

## When NOT to use it

- Anything where you'd be sad if a server restart wiped the state.

For production, use [`@stateledger/prisma`](https://www.npmjs.com/package/@stateledger/prisma)
(coming soon) or another persistent adapter.

## License

MIT
