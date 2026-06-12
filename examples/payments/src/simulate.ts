/**
 * Runnable demo of the payments machine.
 *
 * Walks through five scenarios that each highlight a value prop of
 * stateledger:
 *   1. Happy path with persisted history
 *   2. Transactional after-callback (ledger entry written atomically)
 *   3. Invalid transition rejection (declared transitions enforced)
 *   4. Guard rejection (business preconditions enforced)
 *   5. Concurrent webhook race (locking + state validation prevent double-spend)
 *
 * Run after `pnpm db:setup`:
 *   pnpm simulate
 */

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@stateledger/prisma";
import { GuardRejected, InvalidTransition } from "@stateledger/core";

import { PaymentMachine, type PaymentSubject } from "./machine.js";

const prisma = new PrismaClient();
const adapter = createPrismaAdapter(prisma);

async function createPayment(amount: number, customerEmail: string): Promise<PaymentSubject> {
  const id = randomUUID();
  await prisma.payment.create({
    data: { id, amount, currency: "GBP", customerEmail },
  });
  return { id, amount, currency: "GBP", customerEmail };
}

function bind(subject: PaymentSubject, actorId: string, actorType: string) {
  return PaymentMachine.for(subject.id, {
    adapter,
    actor: { id: actorId, type: actorType },
    subject,
  });
}

async function printHistory(label: string, subject: PaymentSubject): Promise<void> {
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
  console.log("\n[1] Happy path: pending → authorized → captured (and history is persisted)");
  const p = await createPayment(2500, "alice@example.com");
  const m = bind(p, "u-42", "USER");
  await m.transitionTo("pending");
  await m.transitionTo("authorized");
  await m.transitionTo("captured");
  await printHistory("history", p);

  const ledger = await prisma.ledgerEntry.findMany({ where: { paymentId: p.id } });
  console.log(
    `  ledger: ${ledger.length} entry written transactionally with the capture` +
      ` (kind=${ledger[0]?.kind})`,
  );
}

async function scenarioInvalidTransition(): Promise<void> {
  console.log("\n[2] Invalid transition: pending → settled (skipping authorized + captured)");
  const p = await createPayment(1000, "bob@example.com");
  const m = bind(p, "system", "SYSTEM");
  await m.transitionTo("pending");
  try {
    await m.transitionTo("settled");
    console.log("  ?? should not reach here");
  } catch (err) {
    if (err instanceof InvalidTransition) {
      console.log(`  rejected with InvalidTransition: ${err.message}`);
    } else {
      throw err;
    }
  }
}

async function scenarioGuardRejection(): Promise<void> {
  console.log("\n[3] Guard rejection: a zero-amount payment can't be authorized");
  const p = await createPayment(0, "eve@example.com");
  const m = bind(p, "system", "SYSTEM");
  await m.transitionTo("pending");
  try {
    await m.transitionTo("authorized");
    console.log("  ?? should not reach here");
  } catch (err) {
    if (err instanceof GuardRejected) {
      console.log(`  rejected with GuardRejected: ${err.message}`);
    } else {
      throw err;
    }
  }
}

async function scenarioConcurrentWebhooks(): Promise<void> {
  console.log("\n[4] Concurrent webhooks: two requests both try to authorize the same payment");
  const p = await createPayment(5000, "frank@example.com");
  await bind(p, "system", "SYSTEM").transitionTo("pending");

  // Two webhooks race. Pessimistic locking serializes them — the second one
  // wakes up to find the payment already authorized and fails validation.
  const results = await Promise.allSettled([
    bind(p, "webhook-A", "WEBHOOK").transitionTo("authorized"),
    bind(p, "webhook-B", "WEBHOOK").transitionTo("authorized"),
  ]);
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  console.log(`  ${succeeded} succeeded, ${failed} rejected — no double-authorize possible`);
  await printHistory("history (still a single authorization)", p);
}

async function main(): Promise<void> {
  console.log("=== @stateledger/prisma — payments example ===");
  await scenarioHappyPath();
  await scenarioInvalidTransition();
  await scenarioGuardRejection();
  await scenarioConcurrentWebhooks();
  console.log("\nAll scenarios completed.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
