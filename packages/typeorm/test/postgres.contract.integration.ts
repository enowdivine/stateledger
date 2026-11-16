/**
 * Integration test pack for the TypeORM adapter | runs the shared
 * `runContractTests` suite against a real Postgres booted via testcontainers.
 *
 * Uses the `.integration.ts` extension instead of `.test.ts` so it's
 * skipped by the default vitest test-file discovery | contributors
 * without Docker can still run `pnpm test`. The `test:integration`
 * script overrides the include pattern to pick this up.
 *
 * The `DataSource` is deliberately configured with no entities and
 * `synchronize: false`: the transitions table is created from
 * `STATELEDGER_SCHEMA_STATEMENTS`, exactly as a consumer would create it in a
 * migration, and there is no entity class for TypeORM to synchronize.
 *
 * Note there is no `import "reflect-metadata"` here. TypeORM 1.x requires it
 * itself from its own entry point, and this suite declares no decorated
 * classes anyway. See the README.
 *
 * Run locally:
 *   pnpm --filter @stateledger/typeorm test:integration
 */

import { afterAll, beforeAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { runContractTests } from "@stateledger/core/contract-tests";
import { DataSource } from "typeorm";

import { createTypeormAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

let container: StartedTestContainer;
let dataSource: DataSource;

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

  dataSource = new DataSource({
    type: "postgres",
    host: container.getHost(),
    port: container.getMappedPort(5432),
    username: "stateledger",
    password: "stateledger",
    database: "stateledger_test",
    entities: [],
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();

  // Apply schema, one statement at a time | `query()` sends a single
  // statement per call.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await dataSource.query(stmt);
  }
}, 120_000);

afterAll(async () => {
  await dataSource?.destroy();
  await container?.stop();
});

runContractTests({
  label: "TypeormAdapter (real Postgres, DataSource)",
  setup: async () => {
    // Wipe between tests so each one sees a clean slate.
    await dataSource.query(`TRUNCATE "stateledger_transitions"`);
    const adapter = createTypeormAdapter(dataSource);
    return {
      adapter,
      teardown: async () => {
        // Nothing per-test | DataSource/container teardown is in afterAll.
      },
    };
  },
});
