/**
 * The PaymentMachine — every payment in this example flows through it.
 *
 * The `as const` on the config literal is what makes the State union
 * narrow correctly (TypeScript would otherwise widen `states` to
 * `string[]`).
 */

import { defineMachine } from "@stateledger/core";
import type { Prisma } from "@prisma/client";

export type PaymentSubject = {
  id: string;
  amount: number;
  currency: string;
  customerEmail: string;
};

export const PaymentMachine = defineMachine({
  name: "payment",
  states: ["pending", "authorized", "captured", "settled", "failed", "refunded"],
  initialState: "pending",
  transitions: [
    { from: "pending", to: "authorized" },
    { from: "pending", to: "failed" },
    { from: "authorized", to: "captured" },
    { from: "authorized", to: "failed" },
    { from: "captured", to: "settled" },
    { from: "captured", to: "refunded" },
    { from: "settled", to: "refunded" },
  ],
  guards: {
    // Don't authorize a zero-amount payment — silly business rule, useful demo.
    "pending->authorized": ({ subject }) => {
      const p = subject as PaymentSubject;
      return p.amount > 0;
    },
  },
  callbacks: {
    // After a capture, write a ledger entry. Both writes share the same
    // transaction — if the ledger insert throws (constraint violation,
    // connection drop), the transition rolls back too. No "captured
    // payment with no ledger entry" can ever land in the database.
    "after:authorized->captured": async (ctx) => {
      const p = ctx.subject as PaymentSubject;
      const tx = ctx.tx as Prisma.TransactionClient;
      await tx.ledgerEntry.create({
        data: {
          paymentId: p.id,
          amount: p.amount,
          currency: p.currency,
          kind: "CAPTURE",
        },
      });
    },
  },
} as const);
