/**
 * The PaymentMachine — every payment in this example flows through it.
 *
 * The `as const` on the config literal is what makes the State union
 * narrow correctly (TypeScript would otherwise widen `states` to
 * `string[]`).
 */

import { defineMachine } from "@stateledger/core";
import { enqueue } from "@stateledger/outbox";
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
    // After a capture, do TWO things in the same transaction:
    //
    //  1. Write a ledger entry. In-database side effect — safe to do inline
    //     because it's on the same connection as the transition write.
    //
    //  2. Enqueue an outbox note to send the customer a receipt email.
    //     The email itself is an OUT-of-database side effect (SMTP, HTTP,
    //     mail provider), which is exactly the case the outbox is for —
    //     doing it inline would risk a "captured payment but no email"
    //     drift if the mail server is down or the process crashes.
    //
    // Both writes commit atomically with the transition. If either throws,
    // the whole transaction rolls back and no state changed.
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

      await enqueue(tx, {
        kind: "receipt.email",
        payload: {
          paymentId: p.id,
          to: p.customerEmail,
          amount: p.amount,
          currency: p.currency,
        },
      });
    },
  },
} as const);
