/**
 * Runnable demo for the subscription example.
 *
 * Covers four scenarios:
 *   1. Happy path — trial → active → past_due → active → canceled
 *   2. Reactivation — canceled → reactivated → active
 *   3. Time-travel: "what state was this subscription in last month?"
 *      (the new v0.2.0 API; powers billing snapshots + support questions)
 *   4. Concurrent billing run — many subscriptions transitioned in
 *      parallel under OPTIMISTIC concurrency mode (no advisory locks)
 *
 * Run after `pnpm db:setup`:
 *   pnpm simulate
 */

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@stateledger/prisma";

import { SubscriptionMachine, type SubscriptionSubject } from "./machine.js";

const prisma = new PrismaClient();

// Optimistic concurrency: the adapter skips advisory locks. Concurrent
// writers race; the partial unique index on `most_recent` rejects the loser
// with OptimisticConcurrencyError, which the caller catches + retries.
const adapter = createPrismaAdapter(prisma, { locking: "optimistic" });

async function createSubscription(plan: string, price: number, email: string): Promise<SubscriptionSubject> {
  const id = randomUUID();
  await prisma.subscription.create({
    data: { id, planCode: plan, monthlyPrice: price, currency: "USD", customerEmail: email },
  });
  return { id, planCode: plan, monthlyPrice: price, currency: "USD", customerEmail: email };
}

function bind(subject: SubscriptionSubject, actorId: string, actorType: string) {
  return SubscriptionMachine.for(subject.id, {
    adapter,
    actor: { id: actorId, type: actorType },
    subject,
  });
}

async function printHistory(label: string, subject: SubscriptionSubject): Promise<void> {
  const m = bind(subject, "reader", "SYSTEM");
  const rows = await m.history();
  console.log(`  ${label}:`);
  for (const r of rows) {
    console.log(
      `    ${(r.fromState ?? "<initial>").padEnd(12)} → ${r.toState.padEnd(12)}` +
        `  ${r.actorType}:${r.actorId}  @ ${r.createdAt.toISOString()}`,
    );
  }
}

async function scenarioHappyPath(): Promise<void> {
  console.log("\n[1] Happy path: trial → active → past_due → active → canceled");
  const sub = await createSubscription("starter", 1900, "alice@example.com");
  const m = bind(sub, "u-42", "USER");
  await m.transitionTo("trial");
  await m.transitionTo("active");
  await m.transitionTo("past_due");
  await m.transitionTo("active");
  await m.transitionTo("canceled");
  await printHistory("history", sub);
}

async function scenarioReactivation(): Promise<void> {
  console.log("\n[2] Reactivation: canceled → reactivated → active");
  const sub = await createSubscription("pro", 4900, "bob@example.com");
  const m = bind(sub, "u-7", "USER");
  await m.transitionTo("trial");
  await m.transitionTo("active");
  await m.transitionTo("canceled");
  await m.transitionTo("reactivated");
  await m.transitionTo("active");
  await printHistory("history", sub);
}

async function scenarioTimeTravel(): Promise<void> {
  console.log("\n[3] Time-travel: 'what state was this subscription in last month?'");
  const sub = await createSubscription("starter", 1900, "carol@example.com");
  const m = bind(sub, "u-9", "USER");

  // Build out a small timeline so we can travel through it.
  //
  // We anchor each "snapshot" timestamp to the database's own `createdAt`
  // on the row we just wrote, NOT to the host's `new Date()`. With Docker
  // Postgres the container clock and the host clock can drift by tens or
  // hundreds of milliseconds in either direction — anchoring to the row's
  // own timestamp removes that variable entirely. A 1-ms epsilon ensures
  // the cutoff is strictly after the row commit so `created_at <= cutoff`
  // includes it.
  const trialRow = await m.transitionTo("trial");
  const afterTrial = new Date(trialRow.createdAt.getTime() + 1);

  const activeRow = await m.transitionTo("active");
  const afterActive = new Date(activeRow.createdAt.getTime() + 1);

  await m.transitionTo("past_due");
  await m.transitionTo("canceled");

  console.log(`  Now (after canceled):           ${await m.stateAt(new Date())}`);
  console.log(`  Right after the active flip:    ${await m.stateAt(afterActive)}`);
  console.log(`  During the trial:               ${await m.stateAt(afterTrial)}`);
  console.log(`  Before the subscription existed: ${String(await m.stateAt(new Date(0)))}`);
  console.log("");
  console.log("  Use case: end-of-month billing job — for each subscription, ask");
  console.log("  `stateAt(endOfMonth)` and charge whoever was 'active' at that exact instant.");
}

async function scenarioConcurrentBilling(): Promise<void> {
  console.log("\n[4] Concurrent billing run: 10 subscriptions transitioned in parallel (optimistic mode)");

  // Spin up 10 trial subscriptions.
  const subs = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      createSubscription("starter", 1900, `batch-${i}@example.com`),
    ),
  );
  await Promise.all(
    subs.map((s) => bind(s, "u-batch", "USER").transitionTo("trial")),
  );

  // Now run a billing job in parallel: each subscription flips trial → active.
  // Under optimistic mode there's no advisory lock — every worker just hits
  // the DB; the partial unique index serializes them at write time.
  const results = await Promise.allSettled(
    subs.map((s) => bind(s, "billing-job", "SYSTEM").transitionTo("active")),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  console.log(`  ${ok} succeeded, ${failed} rejected — all without taking a single advisory lock.`);
}

async function main(): Promise<void> {
  console.log("=== @stateledger/prisma — subscriptions example (optimistic mode) ===");
  await scenarioHappyPath();
  await scenarioReactivation();
  await scenarioTimeTravel();
  await scenarioConcurrentBilling();
  console.log("\nAll scenarios completed.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
