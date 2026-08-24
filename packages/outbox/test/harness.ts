/**
 * Test harness for @stateledger/outbox.
 *
 * The package is Postgres-native and structurally typed on the client's
 * raw-SQL escape hatches (`OutboxTx`). We use `pg` directly here rather
 * than Prisma so the tests don't depend on Prisma's code-generation step
 * — matches the "any client with `$queryRawUnsafe`/`$executeRawUnsafe`
 * works" promise the README makes to users.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Pool, type Client, type PoolClient } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { OUTBOX_SCHEMA_STATEMENTS } from "../src/schema-sql.js";
import type { OutboxTx } from "../src/types.js";

/**
 * Wraps a `pg.Client` or `pg.Pool` in Prisma's raw-SQL surface so we can
 * feed it directly into `enqueue()` and `createWorker()`.
 *
 * Semantics:
 *   - `$executeRawUnsafe(sql, ...values)` → `client.query(sql, values)`,
 *     resolves with the row count so callers that inspect the return
 *     value get something reasonable.
 *   - `$queryRawUnsafe(sql, ...values)` → `client.query(sql, values)`,
 *     resolves with the rows array.
 *
 * `pg` uses `$1`, `$2`, ... placeholders — the same as Prisma's raw
 * escape hatch — so the SQL body needs no rewriting.
 */
export function pgShim(client: Client | Pool | PoolClient): OutboxTx {
  return {
    async $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T> {
      const result = await client.query(query, values);
      return result.rows as unknown as T;
    },
    async $executeRawUnsafe(query: string, ...values: any[]): Promise<unknown> {
      const result = await client.query(query, values);
      return result.rowCount;
    },
  };
}

/**
 * Bring up a fresh Postgres container and apply the outbox schema.
 * Returns everything the tests need to talk to it.
 *
 * Prefer sharing ONE container across a whole test file via `beforeAll` —
 * spin-up is O(seconds) and the tests TRUNCATE between runs.
 */
export async function bootTestPostgres(): Promise<TestPostgresHandle> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "outbox",
      POSTGRES_PASSWORD: "outbox",
      POSTGRES_DB: "outbox_test",
    })
    // Wait until Postgres is accepting connections. `withStartupTimeout` on
    // its own only waits for the container process; Postgres logs "ready to
    // accept connections" twice — once during init-scripts, then again on
    // final startup — so we wait for the 2nd occurrence to avoid CI-race
    // FATAL "database system is starting up" errors.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const url =
    `postgresql://outbox:outbox@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/outbox_test`;

  const pool = new Pool({ connectionString: url, max: 20 });

  for (const stmt of OUTBOX_SCHEMA_STATEMENTS) {
    await pool.query(stmt);
  }

  const tx = pgShim(pool);

  return {
    container,
    pool,
    url,
    tx,
    async stop() {
      await pool.end();
      await container.stop();
    },
    async truncate() {
      await pool.query(`TRUNCATE "stateledger_outbox"`);
    },
    /**
     * Open a fresh transaction and hand the caller a `tx`-shaped shim
     * that talks to that specific connection. Commits or rolls back based
     * on whether `fn` throws — mirrors `prisma.$transaction`.
     */
    async withTransaction<R>(fn: (tx: OutboxTx) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const shim = pgShim(client);
        const result = await fn(shim);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Rollback errors are secondary; surface the original throw.
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export type TestPostgresHandle = {
  container: StartedTestContainer;
  pool: Pool;
  url: string;
  /** Shim over the shared pool — good for outside-of-transaction writes. */
  tx: OutboxTx;
  stop(): Promise<void>;
  truncate(): Promise<void>;
  withTransaction<R>(fn: (tx: OutboxTx) => Promise<R>): Promise<R>;
};

/**
 * Small polling helper for tests | waits until `predicate` returns truthy
 * or `timeoutMs` elapses. Cheaper than sprinkling `setTimeout(1000)` and
 * hoping the worker got its turn.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  {
    timeoutMs = 5_000,
    intervalMs = 50,
    label = "condition",
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
