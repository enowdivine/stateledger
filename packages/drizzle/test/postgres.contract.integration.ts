/**
 * Integration test pack for the Drizzle adapter — runs the shared
 * `runContractTests` suite against a real Postgres booted via testcontainers.
 *
 * Uses the `.integration.ts` extension instead of `.test.ts` so it's
 * skipped by the default vitest test-file discovery — contributors
 * without Docker can still run `pnpm test`. The `test:integration`
 * script overrides the include pattern to pick this up.
 *
 * Run locally:
 *   pnpm --filter @stateledger/drizzle test:integration
 */

import { afterAll, beforeAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { runContractTests } from "@stateledger/core/contract-tests";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

import { createDrizzleAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

let container: StartedTestContainer;
let pool: Pool;
let db: NodePgDatabase;

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

  const connectionString =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  pool = new Pool({ connectionString });
  db = drizzle(pool);

  // Apply schema, one statement at a time.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await db.execute(sql.raw(stmt));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

runContractTests({
  label: "DrizzleAdapter (real Postgres, node-postgres)",
  setup: async () => {
    // Wipe between tests so each one sees a clean slate.
    await db.execute(sql`TRUNCATE "stateledger_transitions"`);
    const adapter = createDrizzleAdapter(db);
    return {
      adapter,
      teardown: async () => {
        // Nothing per-test — pool/container teardown is in afterAll.
      },
    };
  },
});
