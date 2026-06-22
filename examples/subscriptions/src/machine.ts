/**
 * The SubscriptionMachine — every subscription in this example flows
 * through it.
 *
 * Modeled on a typical SaaS lifecycle:
 *
 *   trial → active → past_due → canceled
 *                  ↘            ↗
 *                   reactivated
 *
 * Why optimistic concurrency here (and not pessimistic, like payments)?
 *
 *   - Subscriptions rarely have racing webhooks. The most common write
 *     paths are the customer hitting "cancel" or the billing run flipping
 *     a status — those don't pile up on the same subject.
 *   - Optimistic mode skips the per-subject advisory lock, so the billing
 *     run can iterate every subscription in parallel without queuing.
 *   - If a race DOES happen (rare), the partial unique index on
 *     `most_recent` rejects the loser with OptimisticConcurrencyError;
 *     the worker just retries.
 *
 * That's the opposite trade-off from the payments example — and it's the
 * point of having a second example, to show both modes in real code.
 */

import { defineMachine } from "@stateledger/core";

export type SubscriptionSubject = {
  id: string;
  planCode: string;
  monthlyPrice: number;
  currency: string;
  customerEmail: string;
};

export const SubscriptionMachine = defineMachine({
  name: "subscription",
  states: ["trial", "active", "past_due", "canceled", "reactivated"],
  initialState: "trial",
  transitions: [
    { from: "trial", to: "active" },
    { from: "trial", to: "canceled" },
    { from: "active", to: "past_due" },
    { from: "active", to: "canceled" },
    { from: "past_due", to: "active" },
    { from: "past_due", to: "canceled" },
    { from: "canceled", to: "reactivated" },
    { from: "reactivated", to: "active" },
  ],
} as const);
