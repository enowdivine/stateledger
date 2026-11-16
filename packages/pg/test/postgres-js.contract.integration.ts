/**
 * Integration test pack for the postgres.js adapter | runs the shared
 * `runContractTests` suite against a real Postgres booted via
 * testcontainers.
 *
 * Same suite as `node-postgres.contract.integration.ts`, different driver.
 * The two files boot their own container rather than sharing one, because
 * vitest gives each test file its own module registry and a shared
 * container would have to be torn down by whichever file finished last.
 *
 * Uses the `.integration.ts` extension instead of `.test.ts` so it's
 * skipped by the default vitest test-file discovery | contributors
 * without Docker can still run `pnpm test`. The `test:integration`
 * script overrides the include pattern to pick this up.
 *
 * Run locally:
 *   pnpm --filter @stateledger/pg test:integration
 */

import { afterAll, beforeAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { runContractTests } from "@stateledger/core/contract-tests";
import postgres from "postgres";

import { createPostgresJsAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

let container: StartedTestContainer;
let sql: postgres.Sql;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    // Wait for Postgres to actually accept connections (2nd log occurrence).
    // See the prisma integration test for the full explanation.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const connectionString =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  sql = postgres(connectionString);

  // Apply schema, one statement at a time. postgres.js would need
  // `.simple()` to send a multi-statement script, and `unsafe()` without
  // parameters is the direct equivalent of handing the DDL to psql.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await sql.unsafe(stmt);
  }
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

runContractTests({
  label: "PostgresJsAdapter (real Postgres, postgres.js)",
  setup: async () => {
    // Wipe between tests so each one sees a clean slate.
    await sql.unsafe('TRUNCATE "stateledger_transitions"');
    const adapter = createPostgresJsAdapter(sql);
    return {
      adapter,
      teardown: async () => {
        // Nothing per-test | connection/container teardown is in afterAll.
      },
    };
  },
});
