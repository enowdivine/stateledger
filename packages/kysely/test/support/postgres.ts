/**
 * Shared plumbing for the Kysely adapter's integration suites.
 *
 * Not a test file (no `.integration.ts` suffix), so vitest's include glob
 * leaves it alone and both suites can import from it.
 *
 * Every suite boots its own Postgres container. That is deliberate: vitest
 * runs test files in separate workers, so a module-level container would be
 * booted once per file anyway, and sharing one through `globalSetup` would
 * couple the suites to each other's truncation order.
 */

import type { NewTransitionRow } from "@stateledger/core";
import {
  Kysely,
  PostgresDialect,
  sql,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { STATELEDGER_SCHEMA_STATEMENTS } from "../../src/index.js";

/**
 * The adapter only ever runs raw SQL, so there is nothing to declare. An
 * empty interface is exactly what a real user gets when their `Database`
 * type has no entry for the transitions table, which is the supported setup.
 */
export type TestDatabase = Record<string, never>;

export type PostgresHandle = {
  container: StartedTestContainer;
  connectionString: string;
};

/** Boot a throwaway Postgres and hand back its connection string. */
export async function startPostgres(): Promise<PostgresHandle> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    // `lock_timeout` is a test-suite safety net, not something the adapter
    // needs. Several tests here deliberately contend on rows and advisory
    // locks; if one of them ever leaves a transaction open, the next
    // TRUNCATE in `beforeEach` would otherwise block forever and take the
    // whole file down with 60s timeouts instead of one failing assertion.
    // Every intentional wait in these suites is well under a second.
    .withCommand(["postgres", "-c", "lock_timeout=10000"])
    // Postgres logs "ready to accept connections" once for the bootstrap
    // instance and again for the real one; wait for the second.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  return {
    container,
    connectionString:
      `postgresql://stateledger:stateledger@${container.getHost()}:` +
      `${container.getMappedPort(5432)}/stateledger_test`,
  };
}

export function connect(
  connectionString: string,
  plugins: KyselyPlugin[] = [],
): { db: Kysely<TestDatabase>; pool: Pool } {
  const pool = new Pool({ connectionString });
  const db = new Kysely<TestDatabase>({ dialect: new PostgresDialect({ pool }), plugins });
  return { db, pool };
}

/**
 * Create the ledger table (plus its indexes) under an arbitrary name.
 *
 * The shipped DDL hard-codes `stateledger_transitions`, and the index names
 * are derived from it, so a plain substring swap renames the table and keeps
 * the index names unique per table. Statements go one at a time: Kysely
 * compiles and sends one statement per `execute()`.
 */
export async function applyLedgerSchema(
  db: Kysely<TestDatabase>,
  tableName = "stateledger_transitions",
): Promise<void> {
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await sql.raw(stmt.replaceAll("stateledger_transitions", tableName)).execute(db);
  }
}

/** `NewTransitionRow` with the boring fields filled in. */
export function newRow(
  overrides: Partial<NewTransitionRow> & { toState: string },
): NewTransitionRow {
  return {
    machine: "edge-machine",
    subjectId: "subject-1",
    fromState: null,
    sortKey: 1,
    mostRecent: true,
    actorId: "tester",
    actorType: "SYSTEM",
    metadata: {},
    machineVersion: 1,
    ...overrides,
  };
}

/**
 * Counts every query compiled through the client it is attached to.
 *
 * Used by the identifier-guard tests to prove the guard rejects *before*
 * anything reaches the database. `transformQuery` runs during compilation,
 * which for a raw `sql` fragment happens inside `execute()` immediately
 * before the statement is sent, so "zero transforms" means "nothing ran".
 */
export class QueryCountingPlugin implements KyselyPlugin {
  public count = 0;

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    this.count += 1;
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/**
 * Resolves once `size` callers have arrived, so they can race from one line.
 *
 * Deliberately time-bounded: if the code under test starts serializing the
 * callers (an advisory lock that stopped being a no-op, say), the laggard
 * never arrives, and a plain barrier would hang the test until vitest's
 * timeout instead of failing on the assertion that actually matters.
 */
export function barrier(size: number, timeoutMs = 2_000): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bail = setTimeout(() => release(), timeoutMs);
  bail.unref?.();
  return async () => {
    arrived += 1;
    if (arrived >= size) {
      clearTimeout(bail);
      release();
    }
    await open;
  };
}

/** `TransitionRow` minus the fields Postgres assigns, for cross-client diffing. */
export function withoutGeneratedFields(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy["id"];
  delete copy["createdAt"];
  return copy;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
