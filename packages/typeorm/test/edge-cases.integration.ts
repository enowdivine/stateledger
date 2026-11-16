/**
 * Edge-case integration pack for the TypeORM adapter.
 *
 * The shared `runContractTests` suite covers the happy path in the default
 * pessimistic mode, through a `DataSource` only. This file covers everything
 * that suite cannot see:
 *
 *  - the "join the caller's EntityManager" path, which is half the public API
 *    and the common shape inside a NestJS service;
 *  - connection affinity for the advisory lock, which is the single property
 *    this adapter lives or dies on and was previously only argued for in a
 *    comment;
 *  - `locking: "optimistic"` and the `QueryFailedError` unwrapping it depends on;
 *  - the identifier guard, which is the only thing between a configured
 *    `tableName` and string-concatenated SQL;
 *  - `updateSubjectState`;
 *  - the `[rows, rowCount]` result shape TypeORM returns for UPDATE / DELETE;
 *  - parameter-binding fidelity (jsonb and `Date`), the hazard class that has
 *    bitten two other adapters in this repo;
 *  - rollback and pool hygiene.
 *
 * Every test carries a comment naming the real failure it guards against.
 *
 * Uses the `.integration.ts` extension so the default `pnpm test` run skips it.
 *
 * Run locally:
 *   pnpm --filter @stateledger/typeorm test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { DataSource, QueryFailedError } from "typeorm";
import { Client } from "pg";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import type { NewTransitionRow } from "@stateledger/core";

import { createTypeormAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";
import type { TypeormEntityManagerLike, TypeormExecutor } from "../src/types.js";

const MACHINE = "edge-machine";
const DEFAULT_TABLE = "stateledger_transitions";
/** Second transitions table, used for the custom-`tableName` path. */
const ALT_TABLE = "tenant_a_transitions";
/** Mixed-case transitions table, used to prove identifiers are quoted. */
const MIXED_CASE_TABLE = "MixedCase_Transitions";
/** Transitions table whose sort_key / machine_version are BIGINT. */
const BIGINT_TABLE = "bigint_transitions";
/** Side table that stands in for a consumer's own entity table. */
const SIDE_TABLE = "payments";

let container: StartedTestContainer;
let dataSource: DataSource;
/**
 * A second, completely independent connection. Everything that observes the
 * database *while* an adapter transaction is still open has to go through this
 * and not through `dataSource`, or the observation would just be reading the
 * transaction's own uncommitted snapshot.
 */
let observer: Client;

let subjectSeq = 0;
function uniqueSubject(prefix: string): string {
  subjectSeq += 1;
  return `${prefix}-${subjectSeq}`;
}

function buildRow(
  overrides: Partial<NewTransitionRow> & { toState: string; subjectId: string },
): NewTransitionRow {
  return {
    machine: MACHINE,
    fromState: null,
    sortKey: 1,
    mostRecent: true,
    actorId: "edge-test",
    actorType: "SYSTEM",
    metadata: {},
    machineVersion: 1,
    ...overrides,
  };
}

/** The schema DDL, retargeted at another table name (indexes included). */
function schemaFor(table: string): string[] {
  return STATELEDGER_SCHEMA_STATEMENTS.map((stmt) => stmt.replaceAll(DEFAULT_TABLE, table));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Rendezvous point: every caller waits until `parties` of them have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const gate = deferred<void>();
  return () => {
    arrived += 1;
    if (arrived >= parties) gate.resolve();
    return gate.promise;
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await sleep(10);
  }
}

/** The exact bigint key `acquireLock` passes to `pg_advisory_xact_lock`. */
async function advisoryKey(machine: string, subjectId: string): Promise<bigint> {
  const rows: Array<{ key: string }> = await dataSource.query(
    "SELECT hashtextextended($1, 0)::text AS key",
    [`${machine}:${subjectId}`],
  );
  return BigInt(rows[0]!.key);
}

/**
 * Which backends currently hold the 64-bit advisory lock for `key`, observed
 * from an independent connection.
 *
 * Postgres splits a bigint advisory key across `pg_locks` as `classid` = high
 * 32 bits, `objid` = low 32 bits, `objsubid` = 1. The key itself is signed and
 * the two halves are not, so the reassembled value is wrapped back into signed
 * 64-bit space before comparing.
 */
async function advisoryLockHolders(key: bigint): Promise<number[]> {
  const res = await observer.query<{ pid: number; classid: string; objid: string }>(
    `SELECT pid, classid::bigint::text AS classid, objid::bigint::text AS objid
       FROM pg_locks
      WHERE locktype = 'advisory' AND objsubid = 1 AND granted`,
  );
  return res.rows
    .filter((row) => {
      const unsigned = (BigInt(row.classid) << 32n) | BigInt(row.objid);
      const signed = unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
      return signed === key;
    })
    .map((row) => row.pid);
}

/** Rows for a subject, read from the independent connection (committed only). */
async function committedRows(
  subjectId: string,
  table = DEFAULT_TABLE,
): Promise<Array<{ to_state: string; most_recent: boolean; sort_key: number }>> {
  const res = await observer.query<{
    to_state: string;
    most_recent: boolean;
    sort_key: number;
  }>(
    `SELECT to_state, most_recent, sort_key FROM "${table}"
      WHERE subject_id = $1 ORDER BY sort_key ASC`,
    [subjectId],
  );
  return res.rows;
}

/** The backend pid serving whatever executor is passed in. */
async function backendPid(executor: TypeormExecutor): Promise<number> {
  const rows: Array<{ pid: number }> = await executor.query(
    "SELECT pg_backend_pid() AS pid",
  );
  return rows[0]!.pid;
}

/**
 * An executor that records every statement and never reaches a database. Used
 * to prove that validation failures happen *before* any query is sent.
 */
function recordingClient(): TypeormEntityManagerLike & { calls: string[] } {
  const calls: string[] = [];
  const client: TypeormEntityManagerLike & { calls: string[] } = {
    calls,
    // Mirrors `TypeormExecutor#query`'s generic signature so the stub is
    // assignable without widening the adapter's own types.
    query: <T,>(sql: string) => {
      calls.push(sql);
      return Promise.resolve([] as unknown as T);
    },
    transaction: (run) => run(client),
  };
  return client;
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    // Second occurrence of the ready line: the first is emitted by the image's
    // own bootstrap server, which then shuts down again.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const connection = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    username: "stateledger",
    password: "stateledger",
    database: "stateledger_test",
  };

  dataSource = new DataSource({
    type: "postgres",
    ...connection,
    entities: [],
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();

  observer = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    application_name: "stateledger-observer",
  });
  await observer.connect();

  for (const table of [DEFAULT_TABLE, ALT_TABLE, MIXED_CASE_TABLE, BIGINT_TABLE]) {
    for (const stmt of schemaFor(table)) {
      await dataSource.query(stmt);
    }
  }

  // Same schema, but with the two numeric columns widened to BIGINT, which is
  // the shape `RawTransitionRow` claims to tolerate (pg hands bigint back as a
  // string).
  await dataSource.query(
    `ALTER TABLE "${BIGINT_TABLE}"
       ALTER COLUMN sort_key TYPE BIGINT,
       ALTER COLUMN machine_version TYPE BIGINT`,
  );

  await dataSource.query(
    `CREATE TABLE IF NOT EXISTS "${SIDE_TABLE}" (
       id      TEXT PRIMARY KEY,
       state   TEXT NOT NULL,
       tenant  TEXT,
       amount  INTEGER,
       active  BOOLEAN
     )`,
  );
}, 180_000);

afterAll(async () => {
  await observer?.end();
  await dataSource?.destroy();
  await container?.stop();
});

// ---------------------------------------------------------------------------
// 1. Joining a caller's existing EntityManager
// ---------------------------------------------------------------------------

describe("joining the caller's EntityManager", () => {
  it("joins a live transaction instead of nesting, and rolls back with the caller", async () => {
    // Guards the NestJS-shaped failure: a service method already runs inside
    // `dataSource.transaction()`, builds the adapter from that manager, and the
    // transition must share the caller's atomicity. If the adapter opened its
    // own transaction the transition would survive a rollback the caller
    // believed was total.
    const subjectId = uniqueSubject("join-rollback");

    await expect(
      dataSource.transaction(async (manager) => {
        const adapter = createTypeormAdapter(manager);
        await adapter.withTransaction(async (tx) => {
          // The handle is the caller's own manager, byte for byte. Anything
          // else means a new runner or a SAVEPOINT was introduced.
          expect(tx).toBe(manager);
          await adapter.acquireLock(tx, MACHINE, subjectId);
          await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
          const current = await adapter.readCurrent(tx, MACHINE, subjectId);
          expect(current?.toState).toBe("pending");
        });
        throw new Error("caller aborts after the transition");
      }),
    ).rejects.toThrow("caller aborts after the transition");

    expect(await committedRows(subjectId)).toEqual([]);
  });

  it("lets a throw inside the joined transaction poison the caller's whole transaction", async () => {
    // Guards against SAVEPOINT semantics sneaking in. If `withTransaction`
    // wrapped the callback in a nested transaction, the throw would roll back
    // only the savepoint and the caller's own earlier write could still commit,
    // leaving a payment row with no matching transition. Join semantics mean
    // all or nothing.
    const subjectId = uniqueSubject("join-poison");
    const paymentId = uniqueSubject("payment");

    await expect(
      dataSource.transaction(async (manager) => {
        await manager.query(`INSERT INTO "${SIDE_TABLE}" (id, state) VALUES ($1, $2)`, [
          paymentId,
          "created",
        ]);
        const adapter = createTypeormAdapter(manager);
        await adapter.withTransaction(async (tx) => {
          await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
          throw new Error("boom inside the joined transaction");
        });
      }),
    ).rejects.toThrow("boom inside the joined transaction");

    expect(await committedRows(subjectId)).toEqual([]);
    const payments = await observer.query(`SELECT id FROM "${SIDE_TABLE}" WHERE id = $1`, [
      paymentId,
    ]);
    expect(payments.rows).toEqual([]);
  });

  it("commits with the caller, and not before", async () => {
    // The other half of the join contract: the adapter must not commit early
    // (a nested transaction would make the transition durable before the caller
    // finished), and must not block the caller's commit either.
    const subjectId = uniqueSubject("join-commit");

    await dataSource.transaction(async (manager) => {
      const adapter = createTypeormAdapter(manager);
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, subjectId);
        await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
      });
      // Still inside the caller's transaction: nothing is visible outside yet.
      expect(await committedRows(subjectId)).toEqual([]);
    });

    expect(await committedRows(subjectId)).toEqual([
      { to_state: "pending", most_recent: true, sort_key: 1 },
    ]);
  });

  it("opens a real transaction on a runner-bound manager that has no transaction active", async () => {
    // Guards the exact branch `isLiveTransactionContext` exists for. A manager
    // built from a bare `createQueryRunner()` carries a runner but no
    // transaction. Joining it would leave every statement in autocommit, where
    // `pg_advisory_xact_lock` is released at the end of its own statement and
    // guards nothing | and the lock call would still succeed, so nothing would
    // look wrong. The pg_locks assertion below is what catches that.
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      expect(runner.isTransactionActive).toBe(false);

      const subjectId = uniqueSubject("runner-bound");
      const key = await advisoryKey(MACHINE, subjectId);
      const adapter = createTypeormAdapter(runner.manager);
      const pidOutside = await backendPid(runner.manager);

      let activeInside = false;
      let pidInside = -1;
      let holdersInside: number[] = [];

      await adapter.withTransaction(async (tx) => {
        activeInside = runner.isTransactionActive;
        // `transaction()` reuses the runner we already own, so the handle is
        // the same manager and affinity is preserved.
        expect(tx).toBe(runner.manager);
        pidInside = await backendPid(tx);
        await adapter.acquireLock(tx, MACHINE, subjectId);
        holdersInside = await advisoryLockHolders(key);
        await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
      });

      expect(activeInside).toBe(true);
      expect(pidInside).toBe(pidOutside);
      // The lock was really held, by this very backend, for the whole callback.
      expect(holdersInside).toEqual([pidInside]);
      expect(runner.isTransactionActive).toBe(false);
      expect(await advisoryLockHolders(key)).toEqual([]);
      expect(await committedRows(subjectId)).toEqual([
        { to_state: "pending", most_recent: true, sort_key: 1 },
      ]);
    } finally {
      await runner.release();
    }
  });

  it("treats the DataSource's global manager like the DataSource and opens its own transaction", async () => {
    // `dataSource.manager` is an EntityManager but has no runner, so there is
    // nothing to join. Guards against the discriminator mistaking it for a
    // transaction-scoped manager, which would run the write in autocommit with
    // a lock that protects nothing.
    const subjectId = uniqueSubject("global-manager");
    const key = await advisoryKey(MACHINE, subjectId);
    const adapter = createTypeormAdapter(dataSource.manager);

    let holdersInside: number[] = [];
    let pidInside = -1;
    await adapter.withTransaction(async (tx) => {
      expect(tx).not.toBe(dataSource.manager);
      pidInside = await backendPid(tx);
      await adapter.acquireLock(tx, MACHINE, subjectId);
      holdersInside = await advisoryLockHolders(key);
      await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
    });

    expect(holdersInside).toEqual([pidInside]);
    expect(await committedRows(subjectId)).toHaveLength(1);
  });

  it("reads with a null tx through the root client, so a joined manager sees its own uncommitted writes", async () => {
    // Guards a read-after-write trap specific to the join path: if the `null`
    // fallback in readHistory / readStateAt reached for the DataSource instead
    // of `this.root`, a service reading history inside its own transaction
    // would not see the transition it just wrote.
    const subjectId = uniqueSubject("null-tx-join");

    await expect(
      dataSource.transaction(async (manager) => {
        const adapter = createTypeormAdapter(manager);
        await adapter.withTransaction(async (tx) => {
          await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
        });

        const history = await adapter.readHistory(null, MACHINE, subjectId);
        expect(history.map((r) => r.toState)).toEqual(["pending"]);

        const asOf = await adapter.readStateAt(null, MACHINE, subjectId, new Date());
        expect(asOf?.toState).toBe("pending");

        throw new Error("discard");
      }),
    ).rejects.toThrow("discard");

    // And an adapter rooted on the DataSource must never have seen it.
    const outside = createTypeormAdapter(dataSource);
    expect(await outside.readHistory(null, MACHINE, subjectId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Connection affinity | the property the whole adapter rests on
// ---------------------------------------------------------------------------

describe("connection affinity of the advisory lock", () => {
  it("holds the lock on the same backend, and in the same transaction, as the INSERT", async () => {
    // THE test for this adapter. A pooled `query()` would take the advisory
    // lock on one connection and insert on another; the lock call still
    // succeeds, so the only way to catch it is to watch from outside. Three
    // facts together pin it down:
    //   1. pg_locks says the lock for our exact key is held, by one backend;
    //   2. that backend is the one serving the transaction handle;
    //   3. the INSERT is invisible from outside at that moment, so it sits in
    //      the still-open transaction that owns the lock.
    const subjectId = uniqueSubject("affinity");
    const key = await advisoryKey(MACHINE, subjectId);
    const adapter = createTypeormAdapter(dataSource);

    expect(await advisoryLockHolders(key)).toEqual([]);

    let txPid = -1;
    let holders: number[] = [];
    let visibleOutsideDuringTx = -1;

    await adapter.withTransaction(async (tx) => {
      txPid = await backendPid(tx);
      await adapter.acquireLock(tx, MACHINE, subjectId);
      holders = await advisoryLockHolders(key);
      await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
      visibleOutsideDuringTx = (await committedRows(subjectId)).length;
      // Same connection before and after the write.
      expect(await backendPid(tx)).toBe(txPid);
    });

    expect(holders).toEqual([txPid]);
    expect(visibleOutsideDuringTx).toBe(0);
    // `pg_advisory_xact_lock` releases on commit | no explicit unlock exists.
    expect(await advisoryLockHolders(key)).toEqual([]);
    expect(await committedRows(subjectId)).toHaveLength(1);
  });

  it("serializes two writers on the same subject: the second genuinely blocks", async () => {
    // Guards against a lock that is taken and released somewhere harmless. A
    // no-op lock lets both writers interleave and both appear to succeed (two
    // rows, no error, and in a real machine two transitions computed from the
    // same stale current state). Here the second writer must not get past
    // `acquireLock` until the first commits.
    const subjectId = uniqueSubject("serialize");
    const adapter = createTypeormAdapter(dataSource);
    const order: string[] = [];
    const gate = deferred<void>();

    const first = adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      order.push("A-locked");
      await gate.promise;
      await adapter.appendTransition(tx, buildRow({ subjectId, toState: "a", sortKey: 1 }));
      order.push("A-committing");
    });

    await waitUntil(() => order.includes("A-locked"));

    const second = adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      order.push("B-locked");
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId, fromState: "a", toState: "b", sortKey: 2 }),
      );
      order.push("B-committing");
    });

    // Long enough that an unserialized B would certainly have finished.
    await sleep(500);
    expect(order).toEqual(["A-locked"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["A-locked", "A-committing", "B-locked", "B-committing"]);
    expect(await committedRows(subjectId)).toEqual([
      { to_state: "a", most_recent: false, sort_key: 1 },
      { to_state: "b", most_recent: true, sort_key: 2 },
    ]);
  });

  it("pins the counterexample: DataSource#query with no pinned runner cannot hold an xact lock", async () => {
    // Not a test of adapter behaviour | a test of the driver fact the adapter
    // is designed around, kept here so the reasoning in `withTransaction`'s doc
    // comment is checked rather than believed. `DataSource#query` checks a
    // runner out of the pool, runs one statement, and releases it in a
    // `finally`, which ends the implicit transaction. The lock call returns
    // success and the lock is already gone. This is precisely the bug that is
    // invisible to a suite which only asserts "the lock call did not throw".
    const subjectId = uniqueSubject("counterexample");
    const lockKey = `${MACHINE}:${subjectId}`;
    const key = await advisoryKey(MACHINE, subjectId);

    const rows = await dataSource.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
      [lockKey],
    );
    expect(rows).toHaveLength(1);

    // It succeeded, and it holds nothing.
    expect(await advisoryLockHolders(key)).toEqual([]);

    // So a second taker is not serialized against it at all.
    const taken = await observer.query<{ got: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS got",
      [lockKey],
    );
    expect(taken.rows[0]!.got).toBe(true);
    await observer.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
  });

  it("scopes the lock key to (machine, subjectId)", async () => {
    // Guards against a lock key that collapses distinct subjects (e.g. keyed on
    // machine only), which would serialize an entire machine's traffic behind
    // one lock and show up as a mysterious throughput ceiling rather than as a
    // test failure.
    const a = await advisoryKey(MACHINE, "subject-a");
    const b = await advisoryKey(MACHINE, "subject-b");
    const c = await advisoryKey("other-machine", "subject-a");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Optimistic locking
// ---------------------------------------------------------------------------

describe('locking: "optimistic"', () => {
  it("takes no advisory lock at all", async () => {
    // Guards against optimistic mode quietly behaving pessimistically. If the
    // lock were still taken, writers would serialize,
    // `OptimisticConcurrencyError` would essentially never fire, and a caller's
    // retry path would go permanently untested in production.
    const subjectId = uniqueSubject("optimistic-nolock");
    const key = await advisoryKey(MACHINE, subjectId);
    const adapter = createTypeormAdapter(dataSource, { locking: "optimistic" });

    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      expect(await advisoryLockHolders(key)).toEqual([]);
      await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" }));
    });

    expect(await committedRows(subjectId)).toHaveLength(1);
  });

  it("produces exactly one winner and an OptimisticConcurrencyError for the loser", async () => {
    // The whole point of optimistic mode. Both writers read the same current
    // state and then race to append. The partial unique index on
    // (machine, subject_id) WHERE most_recent must reject the loser, and the
    // adapter must translate SQLSTATE 23505 into the typed error callers retry
    // on | not a bare AdapterError, which a caller cannot distinguish from a
    // dead connection and must not retry blindly.
    const subjectId = uniqueSubject("optimistic-race");
    const adapter = createTypeormAdapter(dataSource, { locking: "optimistic" });

    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 })),
    );

    const bothRead = barrier(2);
    const attempt = (toState: string): Promise<unknown> =>
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, subjectId);
        const current = await adapter.readCurrent(tx, MACHINE, subjectId);
        expect(current?.toState).toBe("pending");
        // Neither writer may append before both have read, or there is no race.
        await bothRead();
        return adapter.appendTransition(
          tx,
          buildRow({ subjectId, fromState: "pending", toState, sortKey: 2 }),
        );
      });

    const results = await Promise.allSettled([attempt("authorized"), attempt("failed")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(OptimisticConcurrencyError);
    // Specifically NOT the generic wrapper | callers branch on this.
    expect(error).not.toBeInstanceOf(AdapterError);
    expect((error as OptimisticConcurrencyError).machine).toBe(MACHINE);
    expect((error as OptimisticConcurrencyError).subjectId).toBe(subjectId);

    const rows = await committedRows(subjectId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.most_recent)).toHaveLength(1);
  });

  it("pins the TypeORM error shape the 23505 detection reads", async () => {
    // The unique-violation classification is the only thing standing between a
    // lost race and an opaque AdapterError, and it depends on where TypeORM
    // puts the driver's SQLSTATE. Pin both places so a TypeORM change that
    // stops spreading driver properties, or stops exposing `driverError`, fails
    // here loudly instead of silently downgrading OptimisticConcurrencyError to
    // AdapterError and breaking every caller's retry branch.
    const subjectId = uniqueSubject("error-shape");
    await dataSource.query(
      `INSERT INTO "${DEFAULT_TABLE}"
         (machine, subject_id, to_state, sort_key, most_recent, machine_version)
       VALUES ($1, $2, 'pending', 1, TRUE, 1)`,
      [MACHINE, subjectId],
    );

    let caught: unknown;
    try {
      await dataSource.query(
        `INSERT INTO "${DEFAULT_TABLE}"
           (machine, subject_id, to_state, sort_key, most_recent, machine_version)
         VALUES ($1, $2, 'authorized', 2, TRUE, 1)`,
        [MACHINE, subjectId],
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(QueryFailedError);
    const err = caught as QueryFailedError & {
      code?: unknown;
      driverError?: { code?: unknown };
    };
    // The branch the adapter added: the untouched pg error.
    expect(err.driverError?.code).toBe("23505");
    // And the copy TypeORM 1.x spreads onto the wrapper itself.
    expect(err.code).toBe("23505");
  });

  it("classifies a violation that is only visible on driverError", async () => {
    // Proves the `driverError` branch is reachable and load-bearing rather than
    // dead code shadowed by the top-level `code` check. The declared peer range
    // is `typeorm >=0.3`, and older 0.3.x QueryFailedError did not copy the
    // driver's properties onto itself | there, `err.code` is undefined and
    // `err.driverError.code` is the only signal. Without this test, half the
    // supported peer range would be untested.
    const driverStyle = Object.assign(new Error("duplicate key value violates ..."), {
      driverError: { code: "23505" },
    });
    const failing: TypeormEntityManagerLike = {
      query: () => Promise.reject(driverStyle),
      transaction: (run) => run(failing),
    };
    const adapter = createTypeormAdapter(failing);

    await expect(
      adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ subjectId: "stub", toState: "pending" })),
      ),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
  });

  it("does not mistake an unrelated SQLSTATE for a lost race", async () => {
    // The opposite error, and the more dangerous one: classifying every failure
    // as a lost race turns a genuine bug (missing table, dead connection) into
    // an infinite retry loop in the caller.
    const notFound = Object.assign(new Error("relation does not exist"), {
      driverError: { code: "42P01" },
    });
    const failing: TypeormEntityManagerLike = {
      query: () => Promise.reject(notFound),
      transaction: (run) => run(failing),
    };
    const adapter = createTypeormAdapter(failing);

    const error = await adapter
      .withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ subjectId: "stub", toState: "pending" })),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).not.toBeInstanceOf(OptimisticConcurrencyError);
    expect((error as AdapterError).cause).toBe(notFound);
  });
});

// ---------------------------------------------------------------------------
// 4. Custom tableName
// ---------------------------------------------------------------------------

describe("custom tableName", () => {
  it("drives every read and write against the configured table, end to end", async () => {
    // Guards against a statement that forgot `this.table` and fell back to the
    // default | easy to miss, because the default table exists in most
    // deployments, so the write would succeed and simply land in the wrong
    // place. Every statement the adapter issues is exercised here.
    const subjectId = uniqueSubject("alt-table");
    const adapter = createTypeormAdapter(dataSource, { tableName: ALT_TABLE });

    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 }));
    });
    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId, fromState: "pending", toState: "authorized", sortKey: 2 }),
      );
    });

    await adapter.withTransaction(async (tx) => {
      const current = await adapter.readCurrent(tx, MACHINE, subjectId);
      expect(current?.toState).toBe("authorized");
    });
    const history = await adapter.readHistory(null, MACHINE, subjectId);
    expect(history.map((r) => r.toState)).toEqual(["pending", "authorized"]);
    const asOf = await adapter.readStateAt(null, MACHINE, subjectId, new Date());
    expect(asOf?.toState).toBe("authorized");

    // The flip happened in the custom table...
    expect(await committedRows(subjectId, ALT_TABLE)).toEqual([
      { to_state: "pending", most_recent: false, sort_key: 1 },
      { to_state: "authorized", most_recent: true, sort_key: 2 },
    ]);
    // ...and the default table was never touched.
    expect(await committedRows(subjectId, DEFAULT_TABLE)).toEqual([]);
  });

  it("addresses a mixed-case table, which only works because identifiers are quoted", async () => {
    // Guards the reason `quoteIdentifier` exists at all. Postgres folds an
    // unquoted identifier to lower case, so a table created from quoted DDL as
    // "MixedCase_Transitions" is unreachable without the quotes, and the
    // failure is a 42P01 on a table the user can plainly see in psql.
    const subjectId = uniqueSubject("mixed-case");
    const adapter = createTypeormAdapter(dataSource, { tableName: MIXED_CASE_TABLE });

    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending" })),
    );
    expect(await committedRows(subjectId, MIXED_CASE_TABLE)).toHaveLength(1);

    // The folded name really does not exist, which is the whole point.
    await expect(dataSource.query(`SELECT 1 FROM mixedcase_transitions LIMIT 1`)).rejects.toThrow(
      /mixedcase_transitions/,
    );
  });

  it("normalizes BIGINT sort_key and machine_version back to numbers", async () => {
    // `RawTransitionRow` documents that these columns may be widened to BIGINT
    // in a consumer's own migration, and pg hands bigint back as a *string*.
    // Without the `Number()` in `mapRow`, `sortKey` would be "10" and every
    // ordering and comparison decision core builds on it would silently go
    // lexicographic ("10" < "2").
    const subjectId = uniqueSubject("bigint");
    const adapter = createTypeormAdapter(dataSource, { tableName: BIGINT_TABLE });

    const inserted = await adapter.withTransaction((tx) =>
      adapter.appendTransition(
        tx,
        buildRow({ subjectId, toState: "pending", sortKey: 10, machineVersion: 7 }),
      ),
    );
    expect(inserted.sortKey).toBe(10);
    expect(typeof inserted.sortKey).toBe("number");
    expect(inserted.machineVersion).toBe(7);
    expect(typeof inserted.machineVersion).toBe("number");

    const history = await adapter.readHistory(null, MACHINE, subjectId);
    expect(history[0]!.sortKey).toBe(10);
    expect(typeof history[0]!.sortKey).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 5. The identifier guard
// ---------------------------------------------------------------------------

describe("identifier guard", () => {
  const rejected: Array<[string, string]> = [
    ["a double quote", 'transitions"'],
    ["a quote-and-DDL escape attempt", 'x" ; DROP TABLE "stateledger_transitions'],
    ["a semicolon", "transitions; DROP TABLE stateledger_transitions"],
    ["a dot, which would read as a schema qualifier", "public.stateledger_transitions"],
    ["a leading digit", "1_transitions"],
    ["an empty string", ""],
    ["whitespace", "my transitions"],
    ["a trailing space", "transitions "],
    ["a newline", "transitions\nDROP TABLE x"],
    ["a hyphen", "state-ledger"],
    ["a backslash", "transitions\\"],
    ["a NUL byte", "transitions\u0000x"],
    ["a dollar sign", "transitions$1"],
    ["a non-ASCII letter", "transitionsé"],
    ["a name longer than 63 characters", "t".repeat(64)],
  ];

  it.each(rejected)("rejects a tableName containing %s, before any query runs", (_label, tableName) => {
    // The guard rejects rather than escapes: anything that needs quoting to be
    // legal is a misconfiguration, not input to sanitize. Two things matter.
    // That construction throws at all, because the value is concatenated into
    // every statement the adapter issues (Postgres takes no parameter in table
    // position). And that it throws without sending a statement, so a typo
    // never gets a chance to execute | hence the recording client, whose call
    // log must stay empty.
    const client = recordingClient();
    expect(() => createTypeormAdapter(client, { tableName })).toThrow(AdapterError);
    expect(() => createTypeormAdapter(client, { tableName })).toThrow(/invalid SQL identifier/);
    expect(client.calls).toEqual([]);
  });

  it("rejects an over-long name rather than letting Postgres truncate it", async () => {
    // The specific hazard: Postgres does not error on a 70-character
    // identifier, it truncates to NAMEDATALEN - 1 = 63 bytes. Two different
    // configured table names sharing a 63-character prefix would therefore
    // resolve to the same physical table and the adapter would happily mix two
    // tenants' rows together, with no error at any point.
    const sixtyThree = `a${"a".repeat(62)}`;
    const sixtyFour = `a${"a".repeat(63)}`;
    expect(sixtyThree).toHaveLength(63);
    expect(sixtyFour).toHaveLength(64);

    // 63 is legal and must still be accepted.
    expect(() => createTypeormAdapter(dataSource, { tableName: sixtyThree })).not.toThrow();
    expect(() => createTypeormAdapter(dataSource, { tableName: sixtyFour })).toThrow(AdapterError);
    expect(() => createTypeormAdapter(dataSource, { tableName: sixtyFour })).toThrow(/63/);

    // Demonstrates why the guard has to do this: Postgres accepts the 64th
    // character silently and stores a different name than the one it was given.
    await dataSource.query(`CREATE TABLE "${sixtyFour}" (id INT)`);
    const stored = await observer.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE $1",
      ["aaaaaaaaaa%"],
    );
    expect(stored.rows.map((r) => r.table_name)).toEqual([sixtyThree]);
    await dataSource.query(`DROP TABLE "${sixtyThree}"`);
  });

  it("surfaces a bad identifier as itself, not re-wrapped as a query failure", async () => {
    // A deliberate design point worth pinning: `updateSubjectState` quotes its
    // identifiers *before* the try block. If validation happened inside it, a
    // misconfigured table or column name would come back as
    // "updateSubjectState failed for ..." with the real reason buried on
    // `cause`, which is the difference between a five-second fix and an hour of
    // reading stack traces. Asserted by requiring no `cause` at all.
    const client = recordingClient();
    const adapter = createTypeormAdapter(client);

    for (const hint of [
      { model: "payments; DROP TABLE payments", where: { id: "x" } },
      { model: SIDE_TABLE, column: 'state"', where: { id: "x" } },
      { model: SIDE_TABLE, where: { "id; DROP TABLE payments": "x" } },
      { model: "a".repeat(64), where: { id: "x" } },
    ]) {
      const error = await adapter
        .updateSubjectState!(client, hint, "captured")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).message).toMatch(/invalid SQL identifier/);
      expect((error as AdapterError).cause).toBeUndefined();
      expect((error as AdapterError).message).not.toMatch(/updateSubjectState failed/);
    }
    expect(client.calls).toEqual([]);
  });

  it("rejects a missing or empty updateSubjectState hint before querying", async () => {
    // Guards the misconfiguration a consumer actually hits: `subjectStateColumn`
    // half-filled, or an entity class name where a table name belongs. Silently
    // doing nothing would leave the denormalized state column stale forever,
    // with nothing to notice.
    const client = recordingClient();
    const adapter = createTypeormAdapter(client);

    await expect(
      adapter.updateSubjectState!(client, { where: { id: "x" } }, "captured"),
    ).rejects.toThrow(/model is required/);
    await expect(
      adapter.updateSubjectState!(client, { model: SIDE_TABLE }, "captured"),
    ).rejects.toThrow(/where is required/);
    await expect(
      adapter.updateSubjectState!(client, { model: SIDE_TABLE, where: "id" }, "captured"),
    ).rejects.toThrow(/where is required/);
    await expect(
      adapter.updateSubjectState!(client, { model: SIDE_TABLE, where: {} }, "captured"),
    ).rejects.toThrow(/at least one column/);

    expect(client.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. updateSubjectState
// ---------------------------------------------------------------------------

describe("updateSubjectState", () => {
  async function seedPayment(
    id: string,
    extra: { tenant?: string; amount?: number; active?: boolean } = {},
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO "${SIDE_TABLE}" (id, state, tenant, amount, active)
       VALUES ($1, 'created', $2, $3, $4)`,
      [id, extra.tenant ?? null, extra.amount ?? null, extra.active ?? null],
    );
  }

  async function paymentState(id: string): Promise<string | undefined> {
    const res = await observer.query<{ state: string }>(
      `SELECT state FROM "${SIDE_TABLE}" WHERE id = $1`,
      [id],
    );
    return res.rows[0]?.state;
  }

  it("writes the denormalized state column on the subject's own row", async () => {
    // The happy path against a real side table. Guards the two things only a
    // database can check: that `$1` for the new state and `$2..` for the WHERE
    // values line up, and that the UPDATE's `[rows, rowCount]` tuple result
    // does not trip the adapter up.
    const id = uniqueSubject("pay-happy");
    await seedPayment(id);
    const adapter = createTypeormAdapter(dataSource);

    await adapter.withTransaction((tx) =>
      adapter.updateSubjectState!(tx, { model: SIDE_TABLE, where: { id } }, "captured"),
    );

    expect(await paymentState(id)).toBe("captured");
  });

  it("defaults the column to state and honours an explicit column", async () => {
    // Guards the documented default. A silent fallback to the wrong column name
    // would be a 42703 at best, and a write to the wrong column at worst.
    const id = uniqueSubject("pay-column");
    await seedPayment(id);
    const adapter = createTypeormAdapter(dataSource);

    await adapter.withTransaction((tx) =>
      adapter.updateSubjectState!(tx, { model: SIDE_TABLE, where: { id } }, "authorized"),
    );
    expect(await paymentState(id)).toBe("authorized");

    await adapter.withTransaction((tx) =>
      adapter.updateSubjectState!(
        tx,
        { model: SIDE_TABLE, where: { id }, column: "state" },
        "settled",
      ),
    );
    expect(await paymentState(id)).toBe("settled");
  });

  it("numbers multi-column WHERE parameters correctly", async () => {
    // Guards an off-by-one in `$${i + 2}`. With a single WHERE column the bug
    // is invisible; with four, the UPDATE either errors or, worse, compares the
    // wrong values and updates the wrong rows. The decoy row matches three of
    // the four columns.
    const id = uniqueSubject("pay-multi");
    const decoy = uniqueSubject("pay-multi-decoy");
    await seedPayment(id, { tenant: "acme", amount: 500, active: true });
    await seedPayment(decoy, { tenant: "acme", amount: 500, active: true });
    const adapter = createTypeormAdapter(dataSource);

    await adapter.withTransaction((tx) =>
      adapter.updateSubjectState!(
        tx,
        { model: SIDE_TABLE, where: { id, tenant: "acme", amount: 500, active: true } },
        "captured",
      ),
    );

    expect(await paymentState(id)).toBe("captured");
    expect(await paymentState(decoy)).toBe("created");
  });

  it("keeps WHERE values and the new state as bound parameters", async () => {
    // Guards SQL injection through the one place values are not identifiers. A
    // row whose primary key literally contains `'; DROP TABLE` must be matched
    // by that exact string, and a state containing the same must be stored
    // verbatim. If either were interpolated, the side table would be gone by
    // the end of this test.
    const nasty = `x'; DROP TABLE "${SIDE_TABLE}"; --`;
    const nastyState = `captured'; DROP TABLE "${SIDE_TABLE}"; --`;
    await seedPayment(nasty);
    const adapter = createTypeormAdapter(dataSource);

    await adapter.withTransaction((tx) =>
      adapter.updateSubjectState!(tx, { model: SIDE_TABLE, where: { id: nasty } }, nastyState),
    );

    expect(await paymentState(nasty)).toBe(nastyState);
    // The table is still there, and so is everything in it.
    const still = await observer.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${SIDE_TABLE}"`,
    );
    expect(Number(still.rows[0]!.n)).toBeGreaterThan(0);
  });

  it("is a silent no-op when the WHERE matches nothing", async () => {
    // Characterizing the current contract rather than endorsing it: a hint
    // whose `where` matches no row resolves without error, so a wrong `model`
    // or a stale id leaves the denormalized column untouched and nothing
    // anywhere complains. Pinned here so that raising on zero affected rows
    // later is a deliberate, visible decision instead of an accident.
    const adapter = createTypeormAdapter(dataSource);
    await expect(
      adapter.withTransaction((tx) =>
        adapter.updateSubjectState!(
          tx,
          { model: SIDE_TABLE, where: { id: "no-such-payment" } },
          "captured",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("rolls back with the transition it belongs to", async () => {
    // The reason `updateSubjectState` takes the tx handle: the denormalized
    // column and the transition row must never disagree. If the update ran on
    // its own connection, a failed transition would leave the side table
    // claiming a state that was never recorded anywhere.
    const id = uniqueSubject("pay-rollback");
    await seedPayment(id);
    const adapter = createTypeormAdapter(dataSource);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, id);
        await adapter.appendTransition(tx, buildRow({ subjectId: id, toState: "captured" }));
        await adapter.updateSubjectState!(tx, { model: SIDE_TABLE, where: { id } }, "captured");
        throw new Error("after both writes");
      }),
    ).rejects.toThrow("after both writes");

    expect(await paymentState(id)).toBe("created");
    expect(await committedRows(id)).toEqual([]);
  });

  it("wraps a genuine database failure as AdapterError with the cause intact", async () => {
    // A valid identifier pointing at a column that does not exist is a real
    // query failure and must arrive as AdapterError with the driver error
    // preserved | the mirror image of the "bad identifier is not wrapped" test
    // above, and the pair is what makes the two cases distinguishable.
    const id = uniqueSubject("pay-badcol");
    await seedPayment(id);
    const adapter = createTypeormAdapter(dataSource);

    const error = await adapter
      .withTransaction((tx) =>
        adapter.updateSubjectState!(
          tx,
          { model: SIDE_TABLE, where: { id }, column: "no_such_column" },
          "captured",
        ),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).message).toMatch(/updateSubjectState failed/);
    expect((error as AdapterError).cause).toBeInstanceOf(QueryFailedError);
  });
});

// ---------------------------------------------------------------------------
// 7. The [rows, rowCount] sharp edge
// ---------------------------------------------------------------------------

describe("query() result shapes", () => {
  it("pins that UPDATE and DELETE return [rows, rowCount], even with RETURNING", async () => {
    // The assumption the adapter is built on, until now only stated in a
    // comment. TypeORM's Postgres runner special-cases the UPDATE and DELETE
    // commands and returns a tuple. The trap is RETURNING: a future change that
    // rewrote the most_recent flip as `UPDATE ... RETURNING *` and pushed it
    // through `selectRows` would get `[rows, rowCount]` back, read `result[0]`
    // as a row, and map an array into a TransitionRow full of undefined and
    // NaN, with no error anywhere.
    const subjectId = uniqueSubject("tuple");
    await dataSource.query(
      `INSERT INTO "${DEFAULT_TABLE}"
         (machine, subject_id, to_state, sort_key, most_recent, machine_version)
       VALUES ($1, $2, 'pending', 1, TRUE, 1)`,
      [MACHINE, subjectId],
    );

    await dataSource.transaction(async (manager) => {
      const plainUpdate = await manager.query(
        `UPDATE "${DEFAULT_TABLE}" SET actor_id = 'x' WHERE subject_id = $1`,
        [subjectId],
      );
      expect(Array.isArray(plainUpdate)).toBe(true);
      expect(plainUpdate).toHaveLength(2);
      expect(Array.isArray(plainUpdate[0])).toBe(true);
      expect(plainUpdate[1]).toBe(1);

      const returningUpdate = await manager.query(
        `UPDATE "${DEFAULT_TABLE}" SET actor_id = 'y' WHERE subject_id = $1 RETURNING *`,
        [subjectId],
      );
      // Still a tuple, NOT a row list. This is the sharp edge.
      expect(returningUpdate).toHaveLength(2);
      expect(typeof returningUpdate[1]).toBe("number");
      expect(Array.isArray(returningUpdate[0])).toBe(true);
      expect(returningUpdate[0][0].actor_id).toBe("y");

      // SELECT and INSERT ... RETURNING, which `selectRows` IS used on, are
      // plain row arrays with no tuple wrapper.
      const selected = await manager.query(
        `SELECT id FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
        [subjectId],
      );
      expect(selected).toHaveLength(1);
      expect(selected[0].id).toBeTypeOf("string");

      const deleted = await manager.query(
        `DELETE FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
        [subjectId],
      );
      expect(deleted).toHaveLength(2);
      expect(deleted[1]).toBe(1);
    });
  });

  it("flips most_recent correctly despite the tuple result", async () => {
    // The flip is the one UPDATE the adapter issues, and its result is
    // discarded on purpose. Guards against a refactor that routes it through
    // `selectRows`, and against the flip being skipped altogether | three
    // appends must leave exactly one most_recent row, the newest, with the
    // others FALSE rather than NULL (the partial unique index only constrains
    // TRUE, so a NULL would slip past it).
    const subjectId = uniqueSubject("flip");
    const adapter = createTypeormAdapter(dataSource);

    for (const [i, toState] of ["pending", "authorized", "captured"].entries()) {
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, subjectId);
        await adapter.appendTransition(tx, buildRow({ subjectId, toState, sortKey: i + 1 }));
      });
    }

    expect(await committedRows(subjectId)).toEqual([
      { to_state: "pending", most_recent: false, sort_key: 1 },
      { to_state: "authorized", most_recent: false, sort_key: 2 },
      { to_state: "captured", most_recent: true, sort_key: 3 },
    ]);
    const nulls = await observer.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${DEFAULT_TABLE}"
        WHERE subject_id = $1 AND most_recent IS NULL`,
      [subjectId],
    );
    expect(Number(nulls.rows[0]!.n)).toBe(0);
  });

  it("fails loudly when query() hands back something that is not a row array", async () => {
    // `selectRows` exists to turn "this is not a Postgres DataSource" into an
    // error instead of an empty result. Guards against the adapter being
    // pointed at a MySQL or SQLite DataSource, whose `query()` resolves to a
    // driver-specific object, and then reporting that every subject has no
    // history | which reads as data loss rather than misconfiguration.
    const notRows: TypeormEntityManagerLike = {
      query: <T,>() => Promise.resolve({ affectedRows: 0, insertId: 1 } as unknown as T),
      transaction: (run) => run(notRows),
    };
    const adapter = createTypeormAdapter(notRows);

    const error = await adapter.readHistory(null, MACHINE, "whatever").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).message).toMatch(/readHistory failed/);
    expect(((error as AdapterError).cause as Error).message).toMatch(
      /Unexpected query\(\) result shape/,
    );
  });

  it("raises AdapterError, with the driver error on cause, when the table is missing", async () => {
    // The commonest real misconfiguration: the schema DDL was never applied, or
    // `tableName` points at a table nobody created. Must be an AdapterError the
    // caller can catch, with the 42P01 still reachable for whoever debugs it.
    const adapter = createTypeormAdapter(dataSource, { tableName: "not_created_yet" });

    const error = await adapter.readHistory(null, MACHINE, "whatever").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    const cause = (error as AdapterError).cause as QueryFailedError & {
      driverError?: { code?: unknown };
    };
    expect(cause).toBeInstanceOf(QueryFailedError);
    expect(cause.driverError?.code).toBe("42P01");
  });
});

// ---------------------------------------------------------------------------
// 8. Parameter-binding fidelity
// ---------------------------------------------------------------------------

describe("parameter binding fidelity", () => {
  const metadataCases: Array<[string, Record<string, unknown>]> = [
    ["a flat object", { source: "webhook", attempt: 2 }],
    ["a deeply nested object", { outer: { inner: { deep: { deeper: "yes" } } } }],
    ["an array value", { tags: ["a", "b", "c"] }],
    ["an array of objects", { attempts: [{ n: 1 }, { n: 2 }] }],
    ["an empty object", {}],
    ["an empty nested object and array", { obj: {}, arr: [] }],
    ["a unicode value", { note: "crème brûlée 中文 \u{1F642}" }],
    ["a unicode key", { "clé": "valeur" }],
    ["underscore-containing keys", { a_b_c: 1, _leading: 2, trailing_: 3 }],
    ["a key that looks like a placeholder", { $1: "not a parameter", $$: "nor this" }],
    ["a null value", { cancelledAt: null }],
    ["booleans and awkward numbers", { ok: true, no: false, zero: 0, neg: -1.5 }],
    ["a string that looks like JSON", { payload: '{"a":1}' }],
    ["a string that looks like SQL", { note: "'; DROP TABLE stateledger_transitions; --" }],
    ["a string with newlines and quotes", { note: 'line1\nline2 "quoted" \'single\'' }],
    ["a long string", { blob: "x".repeat(5000) }],
  ];

  it.each(metadataCases)(
    "round-trips %s metadata and stores it as a jsonb object",
    async (_label, metadata) => {
      // The hazard class that has already bitten two adapters in this repo:
      // postgres.js double-encoded jsonb in @stateledger/pg, and a raw Date
      // parameter threw in @stateledger/drizzle. Both were invisible because
      // only one driver was ever tested. `jsonb_typeof` is the assertion that
      // catches double encoding: a JSON string that reached the column as text
      // would be stored as a jsonb *string*, and would still round-trip through
      // this adapter's own reads, so comparing values alone proves nothing. The
      // `metadata = $2::jsonb` equality is the second half of the same check,
      // comparing against a document Postgres parsed itself.
      const subjectId = uniqueSubject("meta");
      const adapter = createTypeormAdapter(dataSource);

      const inserted = await adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", metadata })),
      );
      expect(inserted.metadata).toEqual(metadata);

      const reread = await adapter.readHistory(null, MACHINE, subjectId);
      expect(reread[0]!.metadata).toEqual(metadata);

      const typing = await observer.query<{ kind: string; same: boolean }>(
        `SELECT jsonb_typeof(metadata) AS kind, metadata = $2::jsonb AS same
           FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
        [subjectId, JSON.stringify(metadata)],
      );
      expect(typing.rows[0]!.kind).toBe("object");
      expect(typing.rows[0]!.same).toBe(true);
    },
  );

  it("keeps a JSON-looking string a string inside the document", async () => {
    // The double-encoding signature one level down: if a nested value were
    // re-encoded on the way in, `payload` would come back as an object and
    // every `metadata ->> 'payload'` in a consumer's SQL would change meaning.
    const subjectId = uniqueSubject("meta-json-string");
    const adapter = createTypeormAdapter(dataSource);
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(
        tx,
        buildRow({ subjectId, toState: "pending", metadata: { payload: '{"a":1}' } }),
      ),
    );

    const typed = await observer.query<{ kind: string }>(
      `SELECT jsonb_typeof(metadata -> 'payload') AS kind
         FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
      [subjectId],
    );
    expect(typed.rows[0]!.kind).toBe("string");

    const row = await adapter.readHistory(null, MACHINE, subjectId);
    expect(row[0]!.metadata["payload"]).toBe('{"a":1}');
  });

  it("normalizes absent metadata to an empty jsonb object, not a jsonb null", async () => {
    // The reason metadata is stringified and cast explicitly instead of being
    // left to the driver. An undefined or null parameter on an untyped
    // placeholder would land as SQL NULL (violating the NOT NULL column) or as
    // jsonb 'null', which is a different value from '{}' and makes every
    // `metadata ->> 'x'` query in a consumer's code behave differently.
    const adapter = createTypeormAdapter(dataSource);

    for (const absent of [null, undefined]) {
      const subjectId = uniqueSubject("meta-absent");
      const inserted = await adapter.withTransaction((tx) =>
        adapter.appendTransition(
          tx,
          buildRow({
            subjectId,
            toState: "pending",
            metadata: absent as unknown as Record<string, unknown>,
          }),
        ),
      );
      expect(inserted.metadata).toEqual({});

      const typed = await observer.query<{ kind: string }>(
        `SELECT jsonb_typeof(metadata) AS kind
           FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
        [subjectId],
      );
      expect(typed.rows[0]!.kind).toBe("object");
    }
  });

  it("binds quotes and unicode in every text column, including the lock key", async () => {
    // Every text column reaches the driver as a bound parameter. Guards the
    // same injection and encoding hazards as for metadata, and in particular
    // that a subjectId containing a quote still matches itself on read back |
    // it also has to survive being concatenated into the advisory lock key and
    // hashed by `hashtextextended`.
    const machine = `edge'machine"; --`;
    const subjectId = `sub'jecté \u{1F642}; DROP TABLE x`;
    const adapter = createTypeormAdapter(dataSource);

    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, machine, subjectId);
      await adapter.appendTransition(
        tx,
        buildRow({
          machine,
          subjectId,
          toState: "pend'ing",
          actorId: "a'ctor",
          actorType: "SY'STEM",
        }),
      );
    });

    const history = await adapter.readHistory(null, machine, subjectId);
    expect(history).toHaveLength(1);
    expect(history[0]!.machine).toBe(machine);
    expect(history[0]!.subjectId).toBe(subjectId);
    expect(history[0]!.toState).toBe("pend'ing");
    expect(history[0]!.actorId).toBe("a'ctor");

    await adapter.withTransaction(async (tx) => {
      const current = await adapter.readCurrent(tx, machine, subjectId);
      expect(current?.toState).toBe("pend'ing");
    });
  });

  it("round-trips a null fromState and null actor columns", async () => {
    // The bootstrap transition is the only row with a null fromState, and also
    // the row where the most_recent flip matches nothing. Guards against nulls
    // arriving as the string "null" (the classic stringified-parameter bug) and
    // against `mapRow` coercing them to something else.
    const subjectId = uniqueSubject("nulls");
    const adapter = createTypeormAdapter(dataSource);

    const inserted = await adapter.withTransaction((tx) =>
      adapter.appendTransition(
        tx,
        buildRow({ subjectId, toState: "pending", actorId: null, actorType: null }),
      ),
    );
    expect(inserted.fromState).toBeNull();
    expect(inserted.actorId).toBeNull();
    expect(inserted.actorType).toBeNull();

    const raw = await observer.query<{ nulls: string }>(
      `SELECT (from_state IS NULL AND actor_id IS NULL AND actor_type IS NULL)::text AS nulls
         FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
      [subjectId],
    );
    expect(raw.rows[0]!.nulls).toBe("true");
  });

  it("readStateAt accepts a real JS Date as the cutoff", async () => {
    // The @stateledger/drizzle bug this guards against exactly: `readStateAt`
    // threw under postgres.js because a raw JS Date was handed to a TIMESTAMPTZ
    // parameter. It worked under node-postgres, so one driver's green suite
    // proved nothing. Rows here are inserted with explicit whole-millisecond
    // created_at values (which also exercises Date as a *write* parameter) so
    // the boundaries are exact rather than racy.
    const subjectId = uniqueSubject("state-at");
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-02-01T00:00:00.000Z");
    const t3 = new Date("2026-03-01T00:00:00.000Z");
    const seeds: Array<[Date, string]> = [
      [t1, "pending"],
      [t2, "authorized"],
      [t3, "captured"],
    ];

    for (const [i, [at, toState]] of seeds.entries()) {
      await dataSource.query(
        `INSERT INTO "${DEFAULT_TABLE}"
           (machine, subject_id, to_state, sort_key, most_recent, machine_version, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [MACHINE, subjectId, toState, i + 1, i === seeds.length - 1, at],
      );
    }

    const adapter = createTypeormAdapter(dataSource);

    // Exactly on a row's timestamp: `created_at <= $3` is inclusive.
    expect((await adapter.readStateAt(null, MACHINE, subjectId, t2))?.toState).toBe("authorized");
    // One millisecond earlier picks the previous row.
    expect(
      (await adapter.readStateAt(null, MACHINE, subjectId, new Date(t2.getTime() - 1)))?.toState,
    ).toBe("pending");
    // Between rows.
    expect(
      (await adapter.readStateAt(null, MACHINE, subjectId, new Date("2026-02-15T12:00:00Z")))
        ?.toState,
    ).toBe("authorized");
    // Before everything, and after everything.
    expect(await adapter.readStateAt(null, MACHINE, subjectId, new Date(0))).toBeNull();
    expect((await adapter.readStateAt(null, MACHINE, subjectId, new Date()))?.toState).toBe(
      "captured",
    );

    // The round trip also has to come back as a Date, not an ISO string.
    const row = await adapter.readStateAt(null, MACHINE, subjectId, t2);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.createdAt.getTime()).toBe(t2.getTime());
  });

  it("works with a Date cutoff derived from a row the adapter itself wrote", async () => {
    // The realistic time-travel call: read a row, then ask for the state as of
    // that row's own createdAt. Worth pinning because NOW() stores microseconds
    // while the pg driver truncates to milliseconds when it builds the JS Date,
    // so `inserted.createdAt` is usually a hair *earlier* than the value in the
    // column and is not a reliable inclusive cutoff. Adding a millisecond
    // always is, and that is the behaviour callers can depend on.
    const subjectId = uniqueSubject("state-at-live");
    const adapter = createTypeormAdapter(dataSource);

    const first = await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 })),
    );
    await sleep(20);
    await adapter.withTransaction(async (tx) => {
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId, fromState: "pending", toState: "authorized", sortKey: 2 }),
      );
    });

    const asOf = await adapter.readStateAt(
      null,
      MACHINE,
      subjectId,
      new Date(first.createdAt.getTime() + 1),
    );
    expect(asOf?.toState).toBe("pending");
    expect(asOf?.id).toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// 9. Rollback and pool hygiene
// ---------------------------------------------------------------------------

describe("rollback and pool hygiene", () => {
  it("leaves nothing behind and releases the advisory lock on rollback", async () => {
    // Guards two failures at once. A transition surviving a rollback is obvious
    // corruption. An advisory lock surviving a rollback is worse: it is
    // invisible until the next writer on that subject hangs forever.
    const subjectId = uniqueSubject("rollback");
    const key = await advisoryKey(MACHINE, subjectId);
    const adapter = createTypeormAdapter(dataSource);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, subjectId);
        await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 }));
        await adapter.updateSubjectState!(
          tx,
          { model: SIDE_TABLE, where: { id: "irrelevant" } },
          "pending",
        );
        throw new Error("rolling back");
      }),
    ).rejects.toThrow("rolling back");

    expect(await committedRows(subjectId)).toEqual([]);
    expect(await advisoryLockHolders(key)).toEqual([]);

    // And the very next writer gets the lock immediately rather than hanging.
    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 }));
    });
    expect(await committedRows(subjectId)).toHaveLength(1);
  });

  it("does not leak a pooled connection across repeated failing transactions", async () => {
    // The reason `withTransaction` uses `transaction()` rather than driving a
    // QueryRunner by hand: the explicit route puts `release()` in our hands, and
    // a throw on the rollback path leaks the connection. In a long-lived service
    // that exhausts the pool and the process wedges. A pool of two and eight
    // failures makes a leak immediate instead of eventual | with a leak, the
    // third iteration here never acquires a connection and this test times out.
    const probeApp = "stateledger-leak-probe";
    const small = new DataSource({
      type: "postgres",
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: "stateledger",
      password: "stateledger",
      database: "stateledger_test",
      entities: [],
      synchronize: false,
      logging: false,
      poolSize: 2,
      extra: { application_name: probeApp },
    });
    await small.initialize();

    try {
      const adapter = createTypeormAdapter(small);
      const subjectId = uniqueSubject("leak");

      for (let i = 0; i < 8; i += 1) {
        await expect(
          adapter.withTransaction(async (tx) => {
            await adapter.acquireLock(tx, MACHINE, subjectId);
            await adapter.appendTransition(
              tx,
              buildRow({ subjectId, toState: `s${i}`, sortKey: i + 1 }),
            );
            throw new Error(`leak probe ${i}`);
          }),
        ).rejects.toThrow(`leak probe ${i}`);
      }

      expect(await committedRows(subjectId)).toEqual([]);

      // The pool is still fully usable.
      await Promise.all([small.query("SELECT 1"), small.query("SELECT 1")]);

      const backends = await observer.query<{ state: string | null }>(
        `SELECT state FROM pg_stat_activity WHERE application_name = $1`,
        [probeApp],
      );
      expect(backends.rows.length).toBeLessThanOrEqual(2);
      // The signature of a leaked runner: a backend parked mid-transaction.
      expect(backends.rows.filter((r) => r.state === "idle in transaction")).toEqual([]);

      // And real work still commits after all that.
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, subjectId);
        await adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 }));
      });
      expect(await committedRows(subjectId)).toHaveLength(1);
    } finally {
      await small.destroy();
    }
  });

  it("does not release a runner the caller owns", async () => {
    // `EntityManager#transaction` only releases a runner it created itself.
    // Guards against the adapter (or a future refactor of it) releasing a
    // caller-owned QueryRunner, which in NestJS would detonate the caller's
    // remaining work with QueryRunnerAlreadyReleasedError | including on the
    // rollback path, which is where this kind of bug always hides.
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      const adapter = createTypeormAdapter(runner.manager);
      const subjectId = uniqueSubject("owned-runner");

      await adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ subjectId, toState: "pending", sortKey: 1 })),
      );
      expect(runner.isReleased).toBe(false);

      await expect(
        adapter.withTransaction(async (tx) => {
          await adapter.appendTransition(
            tx,
            buildRow({ subjectId, fromState: "pending", toState: "authorized", sortKey: 2 }),
          );
          throw new Error("second attempt fails");
        }),
      ).rejects.toThrow("second attempt fails");

      // Still usable after a rollback on a caller-owned runner.
      expect(runner.isReleased).toBe(false);
      expect(runner.isTransactionActive).toBe(false);
      const after = await runner.manager.query("SELECT 1 AS ok");
      expect(after[0].ok).toBe(1);
      expect(await committedRows(subjectId)).toEqual([
        { to_state: "pending", most_recent: true, sort_key: 1 },
      ]);
    } finally {
      await runner.release();
    }
  });
});
