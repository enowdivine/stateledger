/**
 * Edge cases for `@stateledger/pg` on node-postgres, plus the
 * driver-independent identifier guard.
 *
 * The shared `runContractTests` pack covers the happy path through the
 * root client in default pessimistic mode. Everything in this file is
 * something that pack cannot see: the joined-transaction half of the
 * public API, `locking: "optimistic"`, `tableName`, the identifier
 * whitelist, `updateSubjectState`, parameter-binding fidelity, and
 * connection hygiene on the rollback path.
 *
 * Every test says what real failure it guards against. If a comment does
 * not name a failure, the test is not pulling its weight.
 *
 * Run locally:
 *   pnpm --filter @stateledger/pg test:integration
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import { Pool, type PoolClient } from "pg";

import { createPgAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";
import type { NodePostgresPool, NodePostgresQueryable } from "../src/index.js";
import {
  buildRow,
  CUSTOM_TABLE,
  DEFAULT_TABLE,
  HOSTILE_IDENTIFIERS,
  MACHINE,
  MAX_LENGTH_IDENTIFIER,
  requireUpdateSubjectState,
  RICH_METADATA,
  schemaFor,
  SIDE_TABLE_DDL,
  startPostgres,
} from "./edge-case-helpers.js";

let container: StartedTestContainer;
let connectionString: string;
let pool: Pool;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  connectionString = started.connectionString;

  pool = new Pool({ connectionString });
  // One test deliberately destroys a connection (see "a ROLLBACK that
  // itself fails"). node-postgres re-emits that on the pool, and an
  // unhandled 'error' event on an EventEmitter takes the process down.
  pool.on("error", () => {});

  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) await pool.query(stmt);
  for (const stmt of schemaFor(CUSTOM_TABLE)) await pool.query(stmt);
  await pool.query(SIDE_TABLE_DDL);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE "${DEFAULT_TABLE}", "${CUSTOM_TABLE}", "payments"`);
});

/** Rows in a transition table, straight from the DB, no adapter involved. */
async function rawRows(table = DEFAULT_TABLE): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`SELECT * FROM "${table}" ORDER BY sort_key ASC`);
  return result.rows as Record<string, unknown>[];
}

/** A real NUL byte, kept out of the source text itself. */
const NUL = String.fromCharCode(0);

async function countRows(table: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return (result.rows[0] as { n: number }).n;
}

// ─────────────────────────────────────────────────────────────
// The identifier guard
// ─────────────────────────────────────────────────────────────

/**
 * A client that answers every query with an empty result and remembers
 * what it was asked. Used to prove the identifier guard rejects *before*
 * anything reaches the wire | an adapter that validated late would still
 * throw, and a test that only asserted the throw would not notice that a
 * `DROP TABLE` had already been sent.
 */
function recordingPool(): { client: NodePostgresPool; sent: string[] } {
  const sent: string[] = [];
  const query = async (text: string): Promise<{ rows: unknown[] }> => {
    sent.push(text);
    return { rows: [] };
  };
  return {
    client: {
      query,
      totalCount: 0,
      connect: async () => ({ query, release: () => {} }),
    },
    sent,
  };
}

/** Same thing, shaped as a bare transaction handle. */
function recordingQueryable(): { tx: NodePostgresQueryable; sent: string[] } {
  const sent: string[] = [];
  return {
    tx: {
      query: async (text: string) => {
        sent.push(text);
        return { rows: [] };
      },
    },
    sent,
  };
}

describe("identifier guard (tableName)", () => {
  it.each(HOSTILE_IDENTIFIERS)(
    "rejects a tableName with a %s before sending any query",
    (_label, value) => {
      // Guards against the one real injection hole in this package: no
      // driver can bind an identifier as a parameter, so `tableName` is
      // interpolated into the SQL text. If the whitelist escaped instead
      // of rejecting, `x"; DROP TABLE "stateledger_transitions` would be
      // a working DDL statement inside a SELECT.
      const { client, sent } = recordingPool();
      expect(() => createPgAdapter(client, { tableName: value })).toThrow(AdapterError);
      expect(sent).toEqual([]);
    },
  );

  it("accepts a 63-character tableName (the exact NAMEDATALEN ceiling)", () => {
    // Guards against an off-by-one in the length check that would reject
    // the longest name Postgres actually stores intact.
    const { client } = recordingPool();
    expect(() => createPgAdapter(client, { tableName: MAX_LENGTH_IDENTIFIER })).not.toThrow();
  });

  it("reports the offending name and the pattern in the error message", () => {
    // Guards against a bare "invalid identifier" that leaves the user
    // guessing which option they got wrong.
    const { client } = recordingPool();
    expect(() => createPgAdapter(client, { tableName: "app.transitions" })).toThrow(
      /invalid SQL identifier: "app\.transitions"/,
    );
    expect(() => createPgAdapter(client, { tableName: "a".repeat(64) })).toThrow(
      /too long.*64 characters.*63/s,
    );
  });
});

describe("identifier guard (updateSubjectState)", () => {
  it.each(HOSTILE_IDENTIFIERS)(
    "rejects a model with a %s before sending any query",
    async (_label, value) => {
      // Guards against the second interpolation site: `model`, `column`
      // and every `where` key reach the SQL text as identifiers too, and
      // they come from machine config just like `tableName` does.
      const adapter = createPgAdapter(pool);
      const update = requireUpdateSubjectState(adapter);
      const { tx, sent } = recordingQueryable();
      await expect(update(tx, { model: value, where: { id: "p1" } }, "paid")).rejects.toThrow(
        AdapterError,
      );
      expect(sent).toEqual([]);
    },
  );

  it.each(HOSTILE_IDENTIFIERS)(
    "rejects a column with a %s before sending any query",
    async (_label, value) => {
      const adapter = createPgAdapter(pool);
      const update = requireUpdateSubjectState(adapter);
      const { tx, sent } = recordingQueryable();
      await expect(
        update(tx, { model: "payments", column: value, where: { id: "p1" } }, "paid"),
      ).rejects.toThrow(AdapterError);
      expect(sent).toEqual([]);
    },
  );

  it.each(HOSTILE_IDENTIFIERS)(
    "rejects a where key with a %s before sending any query",
    async (_label, value) => {
      const adapter = createPgAdapter(pool);
      const update = requireUpdateSubjectState(adapter);
      const { tx, sent } = recordingQueryable();
      await expect(
        update(tx, { model: "payments", where: { [value]: "p1" } }, "paid"),
      ).rejects.toThrow(AdapterError);
      expect(sent).toEqual([]);
    },
  );

  it("rejects a malformed hint without sending a query", async () => {
    // Guards against a half-configured `subjectStateColumn` turning into
    // `UPDATE undefined SET state = $1 WHERE` at runtime.
    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);
    const { tx, sent } = recordingQueryable();

    await expect(update(tx, { where: { id: "p1" } }, "paid")).rejects.toThrow(/model is required/);
    await expect(update(tx, { model: 42, where: { id: "p1" } }, "paid")).rejects.toThrow(
      /model is required/,
    );
    await expect(update(tx, { model: "payments" }, "paid")).rejects.toThrow(/where is required/);
    await expect(update(tx, { model: "payments", where: "id = 1" }, "paid")).rejects.toThrow(
      /where is required/,
    );
    await expect(update(tx, { model: "payments", where: {} }, "paid")).rejects.toThrow(
      /at least one column/,
    );
    expect(sent).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Joining the caller's transaction (node-postgres)
// ─────────────────────────────────────────────────────────────

/**
 * A checked-out client wrapped so the test can see exactly what the
 * adapter sent it and whether it tried to take ownership of the
 * connection.
 *
 * `connect` is present because a real `PoolClient` has one (it inherits
 * `Client.connect`), and `isPool` must therefore key on something else.
 * If it ever regresses to keying on `connect`, this object gets treated
 * as a pool and `connect()` throws instead of silently opening a second,
 * non-transactional connection.
 */
type JoinSpy = NodePostgresQueryable & {
  connect(): Promise<never>;
  release(err?: unknown): void;
};

function joinSpy(client: PoolClient): { spy: JoinSpy; sent: string[]; releases: unknown[] } {
  const sent: string[] = [];
  const releases: unknown[] = [];
  const spy: JoinSpy = {
    query: async (text: string, values?: unknown[]) => {
      sent.push(text.trim());
      return client.query(text, values);
    },
    connect: () => {
      throw new Error("adapter treated a checked-out client as a Pool");
    },
    release: (err?: unknown) => {
      releases.push(err);
    },
  };
  return { spy, sent, releases };
}

describe("joining a node-postgres transaction the caller opened", () => {
  it("writes inside the caller's transaction and disappears when the caller rolls back", async () => {
    // This is half the public API and the shared contract pack never
    // touches it. Guards against the adapter checking out its own
    // connection from somewhere (which would make the transition commit
    // independently of the caller's unit of work, the exact atomicity
    // promise the README makes).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const adapter = createPgAdapter(client);

      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(tx, buildRow({ toState: "pending" }));
      });

      // Visible on the caller's connection...
      const inside = await client.query(`SELECT count(*)::int AS n FROM "${DEFAULT_TABLE}"`);
      expect((inside.rows[0] as { n: number }).n).toBe(1);

      // ...and nowhere else, because it is not committed.
      expect(await countRows(DEFAULT_TABLE)).toBe(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // The caller rolled back, so the transition must be gone. If the
    // adapter had emitted its own COMMIT, this would be 1.
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("emits no transaction control and never releases the caller's connection", async () => {
    // Guards against two specific regressions:
    //  - a stray BEGIN/COMMIT/ROLLBACK, which Postgres answers with
    //    "there is already a transaction in progress" (a warning, not an
    //    error) and which would commit the caller's work early;
    //  - calling release() on a connection the adapter does not own,
    //    which hands a live transaction back to the pool for the next
    //    borrower to inherit.
    const client = await pool.connect();
    const { spy, sent, releases } = joinSpy(client);
    try {
      await client.query("BEGIN");
      const adapter = createPgAdapter(spy);

      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(tx, buildRow({ toState: "pending" }));
        await adapter.readCurrent(tx, MACHINE, "subject-1");
      });

      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((s) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(s))).toEqual([]);
      expect(releases).toEqual([]);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("leaves the caller's transaction usable after a failed transition", async () => {
    // Guards against the adapter rolling back a transaction it does not
    // own. A JS-level failure inside the callback (a guard throwing, an
    // `after:` hook throwing) must propagate without destroying the
    // caller's earlier work | if the adapter sneaked in a ROLLBACK here,
    // 'before' would vanish and the user would never know why.
    const client = await pool.connect();
    const { spy, sent } = joinSpy(client);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "payments" (id, tenant, state) VALUES ('before', 't1', 'created')`,
      );

      const adapter = createPgAdapter(spy);
      await expect(
        adapter.withTransaction(async (tx) => {
          await adapter.appendTransition(tx, buildRow({ toState: "pending" }));
          throw new Error("callback blew up");
        }),
      ).rejects.toThrow("callback blew up");

      expect(sent.filter((s) => /^(COMMIT|ROLLBACK)/i.test(s))).toEqual([]);

      // Caller's transaction is still alive and can still commit.
      await client.query(
        `INSERT INTO "payments" (id, tenant, state) VALUES ('after', 't1', 'created')`,
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const ids = await pool.query(`SELECT id FROM "payments" ORDER BY id`);
    expect(ids.rows.map((r) => (r as { id: string }).id)).toEqual(["after", "before"]);
    // The transition the adapter appended committed along with the
    // caller's work, because nothing rolled it back. That is the
    // documented consequence of handing the adapter your transaction:
    // failure containment is yours, not the adapter's.
    expect(await countRows(DEFAULT_TABLE)).toBe(1);
  });

  it("reads with tx=null on the caller's connection, so writes are visible pre-commit", async () => {
    // `readHistory(null, ...)` means "outside any transaction" on a
    // pool-backed adapter, but there is no second connection to read
    // from when the adapter was handed a single client. Documenting the
    // consequence: these reads see the caller's uncommitted writes.
    // Guards against someone "fixing" this by opening a side connection,
    // which would make time-travel reads miss data the caller just wrote.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const adapter = createPgAdapter(client);
      await adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ toState: "pending" })),
      );

      const history = await adapter.readHistory(null, MACHINE, "subject-1");
      expect(history.map((r) => r.toState)).toEqual(["pending"]);

      const at = await adapter.readStateAt(null, MACHINE, "subject-1", new Date());
      expect(at?.toState).toBe("pending");

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// locking: "optimistic"
// ─────────────────────────────────────────────────────────────

describe('locking: "optimistic"', () => {
  it("holds no advisory lock, where pessimistic holds exactly one", async () => {
    // Guards against the option being read but not acted on. Asserting on
    // pg_locks is the only way to see the difference directly | from the
    // outside both modes just work, and a silently-pessimistic
    // "optimistic" adapter would pass every other test in this file
    // while serializing every writer in production.
    const advisoryLocks = async (locking: "pessimistic" | "optimistic") => {
      const adapter = createPgAdapter(pool, { locking });
      return adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        const held = await tx.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
        );
        return (held.rows[0] as { n: number }).n;
      });
    };

    expect(await advisoryLocks("pessimistic")).toBe(1);
    expect(await advisoryLocks("optimistic")).toBe(0);
  });

  it("produces exactly one winner and an OptimisticConcurrencyError for the loser", async () => {
    // Guards the whole point of optimistic mode: with no advisory lock,
    // the partial unique index on most_recent is the only thing left
    // standing between two writers and two "current" rows. The loser must
    // get OptimisticConcurrencyError specifically, because every retry
    // loop in userland is built on `instanceof` | a bare AdapterError
    // here turns a retryable race into a hard failure.
    const adapter = createPgAdapter(pool, { locking: "optimistic" });

    const attempt = (toState: string) =>
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "contended");
        return adapter.appendTransition(
          tx,
          buildRow({ subjectId: "contended", toState, sortKey: 1 }),
        );
      });

    const results = await Promise.allSettled([attempt("A"), attempt("B")]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const reason = (lost[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(OptimisticConcurrencyError);
    expect(reason).not.toBeInstanceOf(AdapterError);
    expect((reason as OptimisticConcurrencyError).machine).toBe(MACHINE);
    expect((reason as OptimisticConcurrencyError).subjectId).toBe("contended");

    // The invariant the index exists to protect survived the race.
    const rows = await rawRows();
    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r["most_recent"] === true)).toHaveLength(1);
  });

  it("keeps one most_recent row when two writers race on an existing subject", async () => {
    // The bootstrap race above never runs the UPDATE that flips the
    // previous most_recent row. This one does, which is the realistic
    // path: both writers try to flip row 1 and insert row 2. Guards
    // against a lost update leaving zero most_recent rows (readCurrent
    // would then return null for a subject that plainly has history).
    const adapter = createPgAdapter(pool, { locking: "optimistic" });
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ subjectId: "contended", toState: "pending" })),
    );

    const attempt = (toState: string) =>
      adapter.withTransaction((tx) =>
        adapter.appendTransition(
          tx,
          buildRow({
            subjectId: "contended",
            fromState: "pending",
            toState,
            sortKey: 2,
          }),
        ),
      );

    const results = await Promise.allSettled([attempt("authorized"), attempt("cancelled")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason as unknown;
    expect(reason).toBeInstanceOf(OptimisticConcurrencyError);

    const rows = await rawRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r["most_recent"] === true)).toHaveLength(1);
    const current = await adapter.withTransaction((tx) =>
      adapter.readCurrent(tx, MACHINE, "contended"),
    );
    expect(current?.sortKey).toBe(2);
  });

  it("maps a duplicate sortKey to OptimisticConcurrencyError, not AdapterError", async () => {
    // NOT a concurrency failure: this is one caller writing the same
    // sortKey twice, sequentially, which is a library/user bug. It lands
    // on OptimisticConcurrencyError anyway because the adapter maps every
    // SQLSTATE 23505 to a lost race, and the subject_sort_key unique
    // index is also a 23505. Pinned here so the over-broad mapping is a
    // deliberate, visible decision rather than something a future reader
    // discovers while debugging an infinite retry loop.
    const adapter = createPgAdapter(pool);
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ toState: "pending", sortKey: 7, mostRecent: false })),
    );
    await expect(
      adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ toState: "other", sortKey: 7, mostRecent: false })),
      ),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
  });
});

// ─────────────────────────────────────────────────────────────
// Custom tableName
// ─────────────────────────────────────────────────────────────

describe("custom tableName", () => {
  it("drives every read and write against the configured table", async () => {
    // Guards against a hard-coded table name sneaking back into any one
    // of the five statements the adapter builds. Each read below is a
    // separate statement with its own interpolation site, and a missed
    // one would quietly read the default table instead | which exists,
    // so it would return plausible-looking wrong answers rather than an
    // error.
    const adapter = createPgAdapter(pool, { tableName: CUSTOM_TABLE });

    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, "subject-1");
      await adapter.appendTransition(tx, buildRow({ toState: "pending", sortKey: 1 }));
    });
    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, "subject-1");
      await adapter.appendTransition(
        tx,
        buildRow({ fromState: "pending", toState: "authorized", sortKey: 2 }),
      );
    });

    const current = await adapter.withTransaction((tx) =>
      adapter.readCurrent(tx, MACHINE, "subject-1"),
    );
    expect(current?.toState).toBe("authorized");
    expect(await adapter.readHistory(null, MACHINE, "subject-1")).toHaveLength(2);
    const at = await adapter.readStateAt(null, MACHINE, "subject-1", new Date());
    expect(at?.toState).toBe("authorized");

    // The shipped DDL retargeted at this table agrees with the adapter's
    // column projection, including the most_recent flip.
    expect(await countRows(CUSTOM_TABLE)).toBe(2);
    const rows = await rawRows(CUSTOM_TABLE);
    expect(rows.filter((r) => r["most_recent"] === true)).toHaveLength(1);

    // And the default table was never touched.
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("wraps a missing table in AdapterError rather than leaking a driver error", async () => {
    // Guards the error contract: a typo'd `tableName` is a configuration
    // mistake users should be able to catch as a StateledgerError, with
    // the driver error preserved on `cause` for diagnosis.
    const adapter = createPgAdapter(pool, { tableName: "no_such_table" });
    const err = await adapter
      .withTransaction((tx) => adapter.appendTransition(tx, buildRow({ toState: "pending" })))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toMatch(/appendTransition failed/);
    expect(((err as AdapterError).cause as { code?: string }).code).toBe("42P01");
  });
});

// ─────────────────────────────────────────────────────────────
// updateSubjectState
// ─────────────────────────────────────────────────────────────

describe("updateSubjectState", () => {
  async function seedPayments(): Promise<void> {
    await pool.query(
      `INSERT INTO "payments" (id, tenant, state, lifecycle_state)
        VALUES ('p1', 't1', 'created', 'created'),
               ('p1', 't2', 'created', 'created'),
               ('p2', 't1', 'created', 'created')`,
    );
  }

  async function stateOf(id: string, tenant: string, column = "state"): Promise<string | null> {
    const r = await pool.query(
      `SELECT "${column}" AS v FROM "payments" WHERE id = $1 AND tenant = $2`,
      [id, tenant],
    );
    return (r.rows[0] as { v: string | null } | undefined)?.v ?? null;
  }

  it("writes the denormalized column on the subject's own row", async () => {
    // Guards the `subjectStateColumn` feature end to end on a real side
    // table: default column name, inside the adapter's transaction.
    await seedPayments();
    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);

    await adapter.withTransaction((tx) =>
      update(tx, { model: "payments", where: { id: "p1", tenant: "t1" } }, "authorized"),
    );

    expect(await stateOf("p1", "t1")).toBe("authorized");
    // Composite where means the sibling rows must be untouched. A dropped
    // predicate would update the whole table and nothing would complain.
    expect(await stateOf("p1", "t2")).toBe("created");
    expect(await stateOf("p2", "t1")).toBe("created");
  });

  it("honours an explicit column", async () => {
    // Guards against `column` being accepted and then ignored, which
    // would silently write to `state` on a table that has no such
    // meaning for it.
    await seedPayments();
    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);

    await adapter.withTransaction((tx) =>
      update(
        tx,
        { model: "payments", column: "lifecycle_state", where: { id: "p2", tenant: "t1" } },
        "captured",
      ),
    );

    expect(await stateOf("p2", "t1", "lifecycle_state")).toBe("captured");
    expect(await stateOf("p2", "t1")).toBe("created");
  });

  it("keeps where values as bound parameters, so SQL in a value stays data", async () => {
    // The identifier guard above protects the identifier slots. This
    // protects the value slots: a subject id that happens to contain SQL
    // must be matched literally, never executed. If `where` values were
    // interpolated, `payments` would no longer exist after this test.
    const hostileId = `p3'; DROP TABLE "payments"; --`;
    await seedPayments();
    await pool.query(`INSERT INTO "payments" (id, tenant, state) VALUES ($1, 't1', 'created')`, [
      hostileId,
    ]);

    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);
    await adapter.withTransaction((tx) =>
      update(tx, { model: "payments", where: { id: hostileId, tenant: "t1" } }, "refunded"),
    );

    expect(await stateOf(hostileId, "t1")).toBe("refunded");
    // Table intact, every other row untouched.
    expect(await countRows("payments")).toBe(4);
    expect(await stateOf("p1", "t1")).toBe("created");
  });

  it("does nothing when the where matches no row", async () => {
    // Pinning current behaviour: the adapter does not inspect rowCount,
    // so a stale or wrong `where` is a silent no-op rather than an error.
    // Worth knowing before someone relies on it to fail loudly.
    await seedPayments();
    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);

    await expect(
      adapter.withTransaction((tx) =>
        update(tx, { model: "payments", where: { id: "ghost", tenant: "t1" } }, "authorized"),
      ),
    ).resolves.toBeUndefined();
    expect(await stateOf("p1", "t1")).toBe("created");
  });

  it("wraps an unknown-but-well-formed column in AdapterError", async () => {
    // A name that passes the whitelist can still not exist. Guards
    // against a raw driver error escaping the adapter's error contract.
    await seedPayments();
    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);

    const err = await adapter
      .withTransaction((tx) =>
        update(
          tx,
          { model: "payments", column: "no_such_column", where: { id: "p1", tenant: "t1" } },
          "authorized",
        ),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toMatch(/updateSubjectState failed for payments/);
    expect(((err as AdapterError).cause as { code?: string }).code).toBe("42703");
  });

  it("rolls back with the transition when the surrounding transaction fails", async () => {
    // The denormalized column and the transition row must move together
    // or the audit trail disagrees with the subject's own row, which is
    // the single worst failure mode this library can have.
    await seedPayments();
    const adapter = createPgAdapter(pool);
    const update = requireUpdateSubjectState(adapter);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ toState: "authorized" }));
        await update(tx, { model: "payments", where: { id: "p1", tenant: "t1" } }, "authorized");
        throw new Error("hook failed after both writes");
      }),
    ).rejects.toThrow("hook failed");

    expect(await stateOf("p1", "t1")).toBe("created");
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Parameter binding and round-trip fidelity
// ─────────────────────────────────────────────────────────────

describe("parameter binding fidelity (node-postgres)", () => {
  it("stores metadata as a jsonb object, not as a JSON string", async () => {
    // The regression test for the double-encode bug: the column held the
    // JSON *string* `"{\"source\":\"test\"}"` instead of an object, which
    // is a perfectly valid jsonb scalar, so nothing failed until a read
    // handed back a string. Asserting jsonb_typeof catches it at rest,
    // where the corruption actually is, instead of two layers later.
    const adapter = createPgAdapter(pool);
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ toState: "pending", metadata: { source: "test" } })),
    );

    const r = await pool.query(
      `SELECT jsonb_typeof(metadata) AS t, metadata->>'source' AS source FROM "${DEFAULT_TABLE}"`,
    );
    expect((r.rows[0] as { t: string }).t).toBe("object");
    expect((r.rows[0] as { source: string }).source).toBe("test");
  });

  it("round-trips every JSON shape byte-faithfully", async () => {
    // One object covering nested objects, arrays, unicode, embedded
    // quotes and backslashes, a string that looks like a placeholder,
    // empty containers, null and numbers. Guards against any encoding
    // layer (driver serializer, ::text::jsonb cast, JSON.parse on the
    // way out) mangling a shape the happy-path test never sends.
    const adapter = createPgAdapter(pool);
    const inserted = await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ toState: "pending", metadata: RICH_METADATA })),
    );
    expect(inserted.metadata).toEqual(RICH_METADATA);

    const read = await adapter.readHistory(null, MACHINE, "subject-1");
    expect(read[0]?.metadata).toEqual(RICH_METADATA);
  });

  it("normalises an empty and an absent metadata to {}", async () => {
    // `metadata` is NOT NULL DEFAULT '{}', and the adapter coerces
    // `undefined`/`null` before sending. Guards against a null reaching
    // the column (not-null violation) or a `null` metadata surfacing to
    // callers who are typed to receive an object.
    const adapter = createPgAdapter(pool);
    await adapter.withTransaction(async (tx) => {
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId: "empty", toState: "pending", metadata: {} }),
      );
      await adapter.appendTransition(
        tx,
        buildRow({
          subjectId: "nullish",
          toState: "pending",
          metadata: null as unknown as Record<string, unknown>,
        }),
      );
    });

    expect((await adapter.readHistory(null, MACHINE, "empty"))[0]?.metadata).toEqual({});
    expect((await adapter.readHistory(null, MACHINE, "nullish"))[0]?.metadata).toEqual({});
    const types = await pool.query(`SELECT jsonb_typeof(metadata) AS t FROM "${DEFAULT_TABLE}"`);
    expect(types.rows.map((r) => (r as { t: string }).t)).toEqual(["object", "object"]);
  });

  it("rejects a NUL byte in metadata as an AdapterError", async () => {
    // jsonb cannot store a NUL byte (SQLSTATE 22P05) and there is nothing the
    // adapter can do about it. Pinned so the failure is a wrapped
    // AdapterError with the driver code on `cause`, and in particular NOT
    // an OptimisticConcurrencyError | a retry loop would spin forever on
    // input that can never succeed.
    const adapter = createPgAdapter(pool);
    const err = await adapter
      .withTransaction((tx) =>
        adapter.appendTransition(
          tx,
          buildRow({ toState: "pending", metadata: { note: `a${NUL}b` } }),
        ),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AdapterError);
    expect(err).not.toBeInstanceOf(OptimisticConcurrencyError);
    expect(((err as AdapterError).cause as { code?: string }).code).toBe("22P05");
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("keeps SQL-looking machine and subject identifiers as data", async () => {
    // machine and subjectId are bound parameters, not interpolated. A
    // subject id containing a quote or a percent sign must round-trip and
    // must not match anything else.
    const adapter = createPgAdapter(pool);
    const weird = `sub'1"; --%_`;
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ subjectId: weird, toState: "pending" })),
    );

    const history = await adapter.readHistory(null, MACHINE, weird);
    expect(history[0]?.subjectId).toBe(weird);
    expect(await adapter.readHistory(null, MACHINE, "sub1")).toEqual([]);
    // `%` and `_` must not behave as LIKE wildcards (the adapter uses `=`,
    // and this is what would catch a well-meaning switch to LIKE).
    expect(await adapter.readHistory(null, MACHINE, `sub'1"; --ab`)).toEqual([]);
  });

  it("returns sortKey and machineVersion as numbers at the INTEGER ceiling", async () => {
    // mapRow runs Number() over both because a user who migrated these
    // columns to BIGINT gets strings back. Guards against the mapping
    // being dropped (callers compare sortKeys with `>`, and "10" > "9" is
    // false) and against an off-by-one at the INTEGER boundary.
    const adapter = createPgAdapter(pool);
    const max = 2_147_483_647;
    const inserted = await adapter.withTransaction((tx) =>
      adapter.appendTransition(
        tx,
        buildRow({ toState: "pending", sortKey: max, machineVersion: max }),
      ),
    );
    expect(inserted.sortKey).toBe(max);
    expect(inserted.machineVersion).toBe(max);
    expect(typeof inserted.sortKey).toBe("number");

    const read = await adapter.readHistory(null, MACHINE, "subject-1");
    expect(read[0]?.sortKey).toBe(max);
    expect(read[0]?.machineVersion).toBe(max);
  });

  it("round-trips a null actor and a null fromState", async () => {
    // The bootstrap transition has fromState null, and a system-triggered
    // transition may have no actor at all. Guards against the mapping
    // turning SQL NULL into the string "null".
    const adapter = createPgAdapter(pool);
    const inserted = await adapter.withTransaction((tx) =>
      adapter.appendTransition(
        tx,
        buildRow({ toState: "pending", fromState: null, actorId: null, actorType: null }),
      ),
    );
    expect(inserted.fromState).toBeNull();
    expect(inserted.actorId).toBeNull();
    expect(inserted.actorType).toBeNull();
    expect((await adapter.readHistory(null, MACHINE, "subject-1"))[0]?.actorId).toBeNull();
  });

  it("reads back a metadata value written outside the adapter, and rejects a non-object", async () => {
    // `metadata::text` is parsed in the adapter, so a row written by a
    // migration or by psql is the one way a non-object can get in.
    // Guards the defensive branch in parseMetadata: a JSON array must
    // throw a clear AdapterError rather than be handed back as if it were
    // a Record, and jsonb `null` must normalise to {}.
    await pool.query(
      `INSERT INTO "${DEFAULT_TABLE}"
        (machine, subject_id, to_state, sort_key, most_recent, metadata)
        VALUES ($1, 'array-meta', 'pending', 1, TRUE, '[1,2]'::jsonb),
               ($1, 'null-meta',  'pending', 1, TRUE, 'null'::jsonb)`,
      [MACHINE],
    );
    const adapter = createPgAdapter(pool);

    await expect(adapter.readHistory(null, MACHINE, "array-meta")).rejects.toThrow(
      /metadata column must hold a JSON object, got array/,
    );
    expect((await adapter.readHistory(null, MACHINE, "null-meta"))[0]?.metadata).toEqual({});
  });
});

describe("readStateAt with real Date cutoffs (node-postgres)", () => {
  it("picks the row that was current at the cutoff, inside and outside a transaction", async () => {
    // Guards against a driver refusing to bind a JS Date (the failure
    // mode that took out `@stateledger/drizzle`'s readStateAt under
    // postgres.js) and against the tiebreak ordering regressing from
    // sort_key to created_at | two rows written in the same transaction
    // can share a created_at to the microsecond, and then only sort_key
    // can order them.
    const adapter = createPgAdapter(pool);
    await pool.query(
      `INSERT INTO "${DEFAULT_TABLE}"
        (machine, subject_id, from_state, to_state, sort_key, most_recent, created_at)
        VALUES ($1, 'subject-1', NULL,       'pending',    1, FALSE, '2026-01-01T00:00:00Z'),
               ($1, 'subject-1', 'pending',  'authorized', 2, FALSE, '2026-02-01T00:00:00Z'),
               ($1, 'subject-1', 'authorized','captured',  3, TRUE,  '2026-03-01T00:00:00Z')`,
      [MACHINE],
    );

    const at = (iso: string) => adapter.readStateAt(null, MACHINE, "subject-1", new Date(iso));
    expect(await at("2025-12-31T23:59:59Z")).toBeNull();
    expect((await at("2026-01-15T00:00:00Z"))?.toState).toBe("pending");
    expect((await at("2026-02-01T00:00:00Z"))?.toState).toBe("authorized");
    expect((await at("2030-01-01T00:00:00Z"))?.toState).toBe("captured");

    // Same query on a transaction handle, which is a different code path
    // (queryOn vs queryOutsideTransaction).
    const inTx = await adapter.withTransaction((tx) =>
      adapter.readStateAt(tx, MACHINE, "subject-1", new Date("2026-02-15T00:00:00Z")),
    );
    expect(inTx?.toState).toBe("authorized");
  });

  it("documents the microsecond cutoff that createdAt itself cannot express", async () => {
    // KNOWN WART, pinned deliberately. created_at is TIMESTAMPTZ with
    // microsecond precision and defaults to NOW(), but a JS Date only
    // holds milliseconds, so the `createdAt` every driver hands back is
    // the stored value truncated. Feeding that Date straight back as a
    // cutoff therefore lands *below* the row it came from, and
    // `created_at <= $3` excludes it:
    //
    //   stateAt(row.createdAt) does not see `row`.
    //
    // Both drivers do this, so it is a schema-level issue (the column
    // would have to be TIMESTAMPTZ(3) to match JS precision), not an
    // adapter bug | fixing it means changing the DDL every adapter ships
    // in lockstep, which is out of scope for this suite. This test exists
    // so the behaviour is discovered here rather than in production.
    await pool.query(
      `INSERT INTO "${DEFAULT_TABLE}"
        (machine, subject_id, to_state, sort_key, most_recent, created_at)
        VALUES ($1, 'micros', 'pending', 1, TRUE, '2026-01-01T00:00:00.123456Z')`,
      [MACHINE],
    );
    const adapter = createPgAdapter(pool);
    const createdAt = (await adapter.readHistory(null, MACHINE, "micros"))[0]?.createdAt;
    if (!createdAt) throw new Error("fixture row was not inserted");

    // The driver-visible timestamp has lost the sub-millisecond tail.
    expect(createdAt.toISOString()).toBe("2026-01-01T00:00:00.123Z");

    // ...so its own createdAt is not a cutoff that finds it.
    expect(await adapter.readStateAt(null, MACHINE, "micros", createdAt)).toBeNull();

    // One millisecond later does find it, which is the workaround.
    const oneMsLater = new Date(createdAt.getTime() + 1);
    expect((await adapter.readStateAt(null, MACHINE, "micros", oneMsLater))?.toState).toBe(
      "pending",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Rollback and connection hygiene
// ─────────────────────────────────────────────────────────────

describe("rollback and connection hygiene (node-postgres)", () => {
  it("leaves nothing behind when the callback throws mid-sequence", async () => {
    // Guards against a partially applied transition: the most_recent flip
    // is a separate statement from the INSERT, so a failure between them
    // could leave a subject with zero current rows.
    const adapter = createPgAdapter(pool);
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ toState: "pending", sortKey: 1 })),
    );

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(
          tx,
          buildRow({ fromState: "pending", toState: "authorized", sortKey: 2 }),
        );
        throw new Error("after-hook failed");
      }),
    ).rejects.toThrow("after-hook failed");

    const rows = await rawRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["to_state"]).toBe("pending");
    expect(rows[0]?.["most_recent"]).toBe(true);
  });

  it("does not leak a pooled connection per failed transaction", async () => {
    // The failure this guards against is a hang, not a wrong answer: a
    // `release()` missed on the rollback path costs one connection per
    // failed transition, and once `max` are gone every later transition
    // waits forever on a checkout that never comes. A 2-connection pool
    // and more failures than that turns the hang into a test timeout.
    const small = new Pool({ connectionString, max: 2 });
    small.on("error", () => {});
    try {
      const adapter = createPgAdapter(small);
      for (let i = 0; i < 6; i++) {
        await expect(
          adapter.withTransaction(async (tx) => {
            await adapter.appendTransition(tx, buildRow({ toState: `s${i}` }));
            throw new Error(`fail ${i}`);
          }),
        ).rejects.toThrow(`fail ${i}`);
      }

      // Still able to check out and commit, and the pool never grew past
      // its cap.
      await adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ toState: "pending" })),
      );
      expect(small.totalCount).toBeLessThanOrEqual(2);
      expect(await countRows(DEFAULT_TABLE)).toBe(1);
    } finally {
      await small.end();
    }
  });

  it("destroys the connection when ROLLBACK itself fails, and reports the original error", async () => {
    // This is the path `client.release(rollbackError)` exists for, and it
    // is only reachable by making ROLLBACK fail, which a healthy server
    // never does. The fake pool below wraps a real checked-out connection
    // and rejects exactly that one statement, which is what a connection
    // dying between the INSERT and the rollback looks like.
    //
    // Two things must hold. The caller must see the original failure, not
    // the rollback failure (the rollback failure is a consequence and
    // masking the cause makes the bug unfindable). And release() must be
    // handed the rollback error, so node-postgres destroys the connection
    // instead of returning one that may still be inside an aborted
    // transaction to the next borrower.
    const releases: unknown[] = [];
    const fakePool: NodePostgresPool = {
      query: (text: string, values?: unknown[]) => pool.query(text, values),
      totalCount: 1,
      connect: async () => {
        const real = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            if (text.trim().toUpperCase() === "ROLLBACK") {
              throw new Error("Connection terminated unexpectedly");
            }
            return real.query(text, values);
          },
          release: (err?: unknown) => {
            releases.push(err);
            real.release(err as Error | undefined);
          },
        };
      },
    };

    const adapter = createPgAdapter(fakePool);
    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ toState: "pending" }));
        throw new Error("the original failure");
      }),
    ).rejects.toThrow("the original failure");

    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
    expect((releases[0] as Error).message).toMatch(/Connection terminated/);

    // The connection was destroyed with its transaction still open, so
    // the server rolled it back for us and the write is gone anyway.
    expect(await countRows(DEFAULT_TABLE)).toBe(0);

    // And the real pool still works afterwards.
    const healthy = createPgAdapter(pool);
    await healthy.withTransaction((tx) =>
      healthy.appendTransition(tx, buildRow({ toState: "pending" })),
    );
    expect(await countRows(DEFAULT_TABLE)).toBe(1);
  });

  it("explains itself when handed something that is not a pg client", async () => {
    // Guards the diagnostic in nodePostgresQueryFn. Handing the factory a
    // knex instance, a Drizzle db, or a postgres.js `sql` is an easy
    // mistake, and `result.rows` being undefined would otherwise surface
    // as "cannot read properties of undefined" from inside mapRow.
    const notAClient: NodePostgresQueryable = {
      query: async () => ({}) as { rows: unknown[] },
    };
    const adapter = createPgAdapter(notAClient);
    await expect(
      adapter.withTransaction((tx) => adapter.readCurrent(tx, MACHINE, "subject-1")),
    ).rejects.toThrow(/did not resolve with `\{ rows \}`/);
  });
});
