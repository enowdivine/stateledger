/**
 * The same shared contract suite as `postgres.contract.integration.ts`, run
 * against the OTHER Drizzle Postgres flavor: `drizzle-orm/postgres-js`.
 *
 * Why a second file for one import change. This adapter advertises support
 * for "any Drizzle Postgres driver", but for its first two releases it was
 * only ever exercised against `drizzle-orm/node-postgres`. The two flavors
 * do not agree on everything: `execute()` resolves to `{ rows }` under
 * node-postgres and to a bare array under postgres.js, and postgres.js
 * additionally infers a parameter's type from the server's statement
 * description and then applies its own serializer for that OID.
 *
 * That last behaviour is not hypothetical. `@stateledger/pg` was caught by
 * it during development: a pre-encoded JSON string bound to a `::jsonb`
 * parameter got `JSON.stringify`d a second time by postgres.js, and what
 * landed in the column was a jsonb *scalar string* holding JSON text rather
 * than a jsonb object. Corrupt at rest, and invisible to a suite that only
 * ran the other driver.
 *
 * Drizzle happens to be safe there, because it binds parameters itself
 * instead of letting postgres.js infer the OID. This file is what keeps
 * that true: it is a regression test for a bug this package does not have
 * and must not acquire.
 */

import { afterAll, beforeAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { runContractTests } from "@stateledger/core/contract-tests";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import { createDrizzleAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

let container: StartedTestContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;

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
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const connectionString =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  client = postgres(connectionString);
  db = drizzle(client);

  // Apply schema, one statement at a time.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await db.execute(sql.raw(stmt));
  }
}, 120_000);

afterAll(async () => {
  // postgres.js needs its own connection closed; there is no pool to end.
  await client?.end();
  await container?.stop();
});

runContractTests({
  label: "DrizzleAdapter (real Postgres, postgres.js)",
  setup: async () => {
    // Wipe between tests so each one sees a clean slate.
    await db.execute(sql`TRUNCATE "stateledger_transitions"`);
    const adapter = createDrizzleAdapter(db);
    return {
      adapter,
      teardown: async () => {
        // Nothing per-test | client/container teardown is in afterAll.
      },
    };
  },
});
