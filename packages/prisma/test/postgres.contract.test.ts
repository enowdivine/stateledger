/**
 * Integration test pack for the Prisma adapter — runs the shared
 * `runContractTests` suite against a real Postgres booted via
 * testcontainers.
 *
 * Skipped from the default `pnpm test` (filename excluded in the
 * package's `test` script) so contributors without Docker can still run
 * unit tests. CI runs this via `pnpm test:integration`.
 *
 * Run locally:
 *   pnpm --filter @stateledger/prisma exec prisma generate \\
 *     --schema test/prisma/schema.prisma
 *   pnpm --filter @stateledger/prisma test:integration
 */

import { afterAll, beforeAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { runContractTests } from "@stateledger/core/contract-tests";

import { PrismaClient } from "../node_modules/.prisma/test-client/index.js";
import { createPrismaAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

let container: StartedTestContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    .withStartupTimeout(60_000)
    .start();

  const url =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  prisma = new PrismaClient({ datasources: { db: { url } } });
  // Prisma's $executeRawUnsafe rejects multi-statement scripts (prepared
  // statements take one statement at a time) — apply each separately.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await prisma.$executeRawUnsafe(stmt);
  }
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

runContractTests({
  label: "PrismaAdapter (real Postgres)",
  setup: async () => {
    // Wipe between tests so each one sees a clean slate.
    await prisma.$executeRawUnsafe(`TRUNCATE "stateledger_transitions"`);
    const adapter = createPrismaAdapter(prisma);
    return {
      adapter,
      teardown: async () => {
        // Nothing per-test — container/prisma teardown is in afterAll.
      },
    };
  },
});
