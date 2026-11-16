/**
 * Integration test pack for the Kysely adapter | runs the shared
 * `runContractTests` suite against a real Postgres booted via testcontainers.
 *
 * Uses the `.integration.ts` extension instead of `.test.ts` so it's
 * skipped by the default vitest test-file discovery | contributors without
 * Docker can still run `pnpm test`. The `test:integration` script overrides
 * the include pattern to pick this up.
 *
 * Run locally:
 *   pnpm --filter @stateledger/kysely test:integration
 */

import { afterAll, beforeAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { runContractTests } from "@stateledger/core/contract-tests";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { createKyselyAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

/**
 * The adapter only ever runs raw SQL, so there is nothing to declare here.
 * An empty interface is exactly what a real user gets when their `Database`
 * type has no entry for `stateledger_transitions`, which is the supported
 * setup and the one worth testing.
 */
type TestDatabase = Record<string, never>;

let container: StartedTestContainer;
let pool: Pool;
let db: Kysely<TestDatabase>;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    // Wait for Postgres to actually accept connections (2nd log occurrence).
    // See prisma integration test for the full explanation.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const connectionString =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  pool = new Pool({ connectionString });
  db = new Kysely<TestDatabase>({ dialect: new PostgresDialect({ pool }) });

  // Apply schema, one statement at a time: Kysely compiles and sends one
  // statement per `execute()`, so the concatenated STATELEDGER_SCHEMA_SQL
  // would be rejected by the driver.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await sql.raw(stmt).execute(db);
  }
}, 120_000);

afterAll(async () => {
  // `db.destroy()` ends the pool Kysely was handed, so calling `pool.end()`
  // as well would throw "Called end on pool more than once". If the container
  // never booted we never built `db`, and the pool was never opened either.
  await db?.destroy();
  await container?.stop();
});

runContractTests({
  label: "KyselyAdapter (real Postgres, node-postgres pool)",
  setup: async () => {
    // Wipe between tests so each one sees a clean slate.
    await sql`TRUNCATE ${sql.table("stateledger_transitions")}`.execute(db);
    const adapter = createKyselyAdapter(db);
    return {
      adapter,
      teardown: async () => {
        // Nothing per-test | pool/container teardown is in afterAll.
      },
    };
  },
});
