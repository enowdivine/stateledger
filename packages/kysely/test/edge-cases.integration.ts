/**
 * Edge-case integration suite for the Kysely adapter.
 *
 * The shared `runContractTests` pack (see `postgres.contract.integration.ts`)
 * covers the happy paths through a root client in pessimistic mode. This file
 * covers what it cannot see: joining a caller's transaction, optimistic
 * locking, a custom `tableName`, the identifier guard, `updateSubjectState`,
 * parameter-binding fidelity, and rollback completeness. The `CamelCasePlugin`
 * matrix lives in `plugin-matrix.integration.ts`.
 *
 * Every test says what real failure it guards against. If a comment here
 * stops being true, the test is wrong, not the comment.
 *
 * Run locally (needs Docker):
 *   pnpm --filter @stateledger/kysely test:integration
 */

import type { Adapter, TransitionRow } from "@stateledger/core";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import { sql, type Kysely } from "kysely";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyAdapter } from "../src/index.js";
import type { KyselyExecutor } from "../src/types.js";
import {
  applyLedgerSchema,
  barrier,
  connect,
  newRow,
  QueryCountingPlugin,
  sleep,
  startPostgres,
  type TestDatabase,
} from "./support/postgres.js";

const MACHINE = "edge-machine";
const LEDGER = "stateledger_transitions";
/** A second ledger table, used by the `tableName` option tests. */
const CUSTOM_LEDGER = "tenant_42_ledger";

let container: StartedTestContainer;
let db: Kysely<TestDatabase>;

/** Separate client whose only job is to count queries that reach the driver. */
let counter: QueryCountingPlugin;
let countingDb: Kysely<TestDatabase>;

beforeAll(async () => {
  const pg = await startPostgres();
  container = pg.container;

  ({ db } = connect(pg.connectionString));
  counter = new QueryCountingPlugin();
  ({ db: countingDb } = connect(pg.connectionString, [counter]));

  await applyLedgerSchema(db, LEDGER);
  await applyLedgerSchema(db, CUSTOM_LEDGER);

  // Side table for `updateSubjectState`. Mixed column types on purpose: the
  // `where` hint has to bind strings, numbers and booleans alike.
  await sql`
    CREATE TABLE payments (
      id         TEXT    PRIMARY KEY,
      tenant_id  INTEGER NOT NULL,
      live       BOOLEAN NOT NULL,
      state      TEXT    NOT NULL,
      shadow     TEXT
    )`.execute(db);
}, 180_000);

afterAll(async () => {
  // `destroy()` ends the pool Kysely was given, so calling `pool.end()` as
  // well would throw "Called end on pool more than once".
  await db?.destroy();
  await countingDb?.destroy();
  await container?.stop();
});

beforeEach(async () => {
  await sql`TRUNCATE ${sql.table(LEDGER)}`.execute(db);
  await sql`TRUNCATE ${sql.table(CUSTOM_LEDGER)}`.execute(db);
  await sql`TRUNCATE payments`.execute(db);
  await sql`
    INSERT INTO payments (id, tenant_id, live, state, shadow) VALUES
      ('pay-1', 42, TRUE,  'pending', NULL),
      ('pay-2', 42, FALSE, 'pending', NULL),
      ('pay-3', 7,  TRUE,  'pending', NULL)`.execute(db);
  counter.count = 0;
});

/** `updateSubjectState` is optional on the interface; this asserts we ship it. */
function updateSubjectState(
  adapter: Adapter<KyselyExecutor>,
): (tx: KyselyExecutor, hint: Record<string, unknown>, newState: string) => Promise<void> {
  const fn = adapter.updateSubjectState;
  if (!fn) throw new Error("the Kysely adapter must implement updateSubjectState");
  return fn.bind(adapter);
}

/**
 * The root client, for the reads that require a `tx` but are not themselves
 * about transaction handling. Keeps those reads outside any transaction.
 */
function rootExecutor(): KyselyExecutor {
  return db;
}

async function countLedgerRows(table = LEDGER): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(db);
  return rows[0]?.n ?? 0;
}

async function paymentRow(
  id: string,
): Promise<{ state: string; shadow: string | null } | undefined> {
  const { rows } = await sql<{ state: string; shadow: string | null }>`
    SELECT state, shadow FROM payments WHERE id = ${id}`.execute(db);
  return rows[0];
}

/** Thrown to force a rollback without being mistaken for a real failure. */
class Rollback extends Error {
  constructor() {
    super("rollback on purpose");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Transaction handling: own vs joined
// ─────────────────────────────────────────────────────────────────────────────

describe("withTransaction: root client vs caller's transaction", () => {
  it("opens its own transaction when handed a root Kysely and commits it", async () => {
    // Guards the `isTransaction === false` branch. If the discriminator were
    // inverted, a root client would be treated as an already-open
    // transaction: `fn` would run with no transaction around it, each write
    // would auto-commit on its own, and rollback would stop working.
    expect(db.isTransaction).toBe(false);

    const adapter = createKyselyAdapter(db);
    const inserted = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(tx, newRow({ subjectId: "own-tx", toState: "pending" })),
    );

    // Read back outside any transaction: proves it really committed.
    const history = await adapter.readHistory(null, MACHINE, "own-tx");
    expect(history.map((r) => r.id)).toEqual([inserted.id]);
  });

  it("joins a caller's Transaction, so the caller's rollback erases the transition", async () => {
    // The whole reason the adapter accepts a `Transaction`: a transition
    // written through it must belong to the caller's unit of work. If the
    // adapter opened its own transaction on another connection instead, this
    // row would survive the rollback below and the subject's ledger would
    // disagree with the caller's own rolled-back writes.
    await expect(
      db.transaction().execute(async (trx) => {
        const adapter = createKyselyAdapter(trx);
        await adapter.withTransaction(async (tx) => {
          await adapter.acquireLock(tx, MACHINE, "joined");
          await adapter.appendTransition(tx, newRow({ subjectId: "joined", toState: "pending" }));
        });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    const root = createKyselyAdapter(db);
    expect(await root.readHistory(null, MACHINE, "joined")).toEqual([]);
    expect(await countLedgerRows()).toBe(0);
  });

  it("joins a caller's Transaction and commits with it when the caller succeeds", async () => {
    // The other half of joining: on the success path the adapter has nothing
    // of its own to commit, and it must not lose the write either.
    const inserted = await db.transaction().execute(async (trx) => {
      const adapter = createKyselyAdapter(trx);
      return adapter.withTransaction(async (tx) =>
        adapter.appendTransition(tx, newRow({ subjectId: "joined-ok", toState: "pending" })),
      );
    });

    const root = createKyselyAdapter(db);
    const current = await root.readCurrent(rootExecutor(), MACHINE, "joined-ok");
    expect(current?.id).toBe(inserted.id);
  });

  it("joins a ControlledTransaction from startTransaction()", async () => {
    // `startTransaction()` hands back a `ControlledTransaction`, which the
    // caller commits or rolls back by hand. It extends `Transaction`, so
    // `isTransaction` is true and the adapter must join it. Guards a
    // discriminator that only recognised the callback-style transaction.
    const trx = await db.startTransaction().execute();
    try {
      const adapter = createKyselyAdapter(trx);
      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, newRow({ subjectId: "controlled", toState: "pending" }));
      });
    } finally {
      // A controlled transaction holds its connection (and its row locks)
      // until the caller ends it, so an assertion failure above must not
      // leave it open: the next test's TRUNCATE would block on it.
      await trx.rollback().execute();
    }

    expect(await countLedgerRows()).toBe(0);
  });

  it("cannot use `.transaction()` to tell a root client from a transaction", async () => {
    // Pins the upstream fact the discriminator rests on: a Kysely
    // `Transaction` IS a `Kysely` and carries a `transaction()` method, so
    // probing for that method cannot distinguish the two, and calling it
    // throws rather than nesting. If Kysely ever turned this into a real
    // nested transaction, `isTransaction` would stop being load-bearing and
    // this test should be revisited deliberately.
    await db.transaction().execute(async (trx) => {
      expect(trx.isTransaction).toBe(true);
      expect(typeof trx.transaction).toBe("function");
      expect(() => trx.transaction()).toThrow();
    });
  });

  it("rejects a client that neither opens transactions nor reports being one", async () => {
    // A hand-rolled or mocked client exposing only `getExecutor()` must fail
    // with a clear AdapterError instead of a TypeError from calling
    // `undefined`, and must never run the callback outside a transaction.
    const executorOnly: KyselyExecutor = { getExecutor: () => db.getExecutor() };
    const adapter = createKyselyAdapter(executorOnly);

    let ran = false;
    await expect(
      adapter.withTransaction(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(ran).toBe(false);
  });

  it("reads with tx=null use the client the adapter was constructed with", async () => {
    // `readHistory(null)` / `readStateAt(null)` fall back to `this.root`. When
    // the adapter was built on a caller's transaction, that fallback IS the
    // caller's transaction, so an uncommitted write is visible to it, which is
    // what callers want (read-after-write inside their own unit of work) and
    // is easy to break by hard-coding a fresh connection for null reads. A
    // separate root client must not see the same row: no dirty reads.
    const root = createKyselyAdapter(db);

    await expect(
      db.transaction().execute(async (trx) => {
        const joined = createKyselyAdapter(trx);
        await joined.withTransaction(async (tx) => {
          await joined.appendTransition(tx, newRow({ subjectId: "null-read", toState: "pending" }));
        });

        expect(await joined.readHistory(null, MACHINE, "null-read")).toHaveLength(1);
        const insideAt = await joined.readStateAt(null, MACHINE, "null-read", new Date());
        expect(insideAt?.toState).toBe("pending");

        // Same instant, different connection: still uncommitted, so empty.
        expect(await root.readHistory(null, MACHINE, "null-read")).toEqual([]);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Optimistic locking
// ─────────────────────────────────────────────────────────────────────────────

describe("locking: optimistic", () => {
  async function raceWriter(
    adapter: Adapter<KyselyExecutor>,
    subjectId: string,
    arrive: () => Promise<void>,
  ): Promise<TransitionRow> {
    return adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      const current = await adapter.readCurrent(tx, MACHINE, subjectId);
      // Both writers reach here before either writes: that is the lost-update
      // window the partial unique index has to catch.
      await arrive();
      return adapter.appendTransition(
        tx,
        newRow({
          subjectId,
          fromState: current?.toState ?? null,
          toState: "settled",
          sortKey: (current?.sortKey ?? 0) + 1,
        }),
      );
    });
  }

  it("gives one winner and an OptimisticConcurrencyError to the loser (bootstrap race)", async () => {
    // Without the advisory lock, two writers that both read "no rows yet"
    // both insert a mostRecent row. The partial unique index rejects the
    // second as SQLSTATE 23505, and the adapter MUST translate that into
    // OptimisticConcurrencyError, the specific class callers retry on. If it
    // leaked as a bare AdapterError, every retry loop in user code would stop
    // firing and the transition would look permanently broken.
    const adapter = createKyselyAdapter(db, { locking: "optimistic" });
    const arrive = barrier(2);

    const results = await Promise.allSettled([
      raceWriter(adapter, "race-boot", arrive),
      raceWriter(adapter, "race-boot", arrive),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejections = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejections).toHaveLength(1);

    const reason: unknown = rejections[0]?.reason;
    expect(reason).toBeInstanceOf(OptimisticConcurrencyError);
    expect(reason).not.toBeInstanceOf(AdapterError);
    expect((reason as OptimisticConcurrencyError).machine).toBe(MACHINE);
    expect((reason as OptimisticConcurrencyError).subjectId).toBe("race-boot");

    // The loser's transaction rolled back, so exactly one row exists and it
    // is the only mostRecent row for the subject.
    expect(await countLedgerRows()).toBe(1);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(LEDGER)}
       WHERE machine = ${MACHINE} AND subject_id = 'race-boot' AND most_recent = TRUE`.execute(db);
    expect(rows[0]?.n).toBe(1);
  });

  it("gives one winner when racing a transition on an existing subject", async () => {
    // The seeded race takes a different Postgres path from the bootstrap one:
    // both writers run the `most_recent = FALSE` UPDATE against the same
    // existing row, so one blocks on a row lock and only then collides on the
    // index. The invariant must hold identically.
    const seed = createKyselyAdapter(db);
    await seed.withTransaction(async (tx) => {
      await seed.appendTransition(tx, newRow({ subjectId: "race-seeded", toState: "pending" }));
    });

    const adapter = createKyselyAdapter(db, { locking: "optimistic" });
    const arrive = barrier(2);
    const results = await Promise.allSettled([
      raceWriter(adapter, "race-seeded", arrive),
      raceWriter(adapter, "race-seeded", arrive),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reason: unknown = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )?.reason;
    expect(reason).toBeInstanceOf(OptimisticConcurrencyError);

    // Seed + winner, and exactly one of them is current.
    const history = await adapter.readHistory(null, MACHINE, "race-seeded");
    expect(history.map((r) => r.toState)).toEqual(["pending", "settled"]);
    expect(history.filter((r) => r.mostRecent).map((r) => r.toState)).toEqual(["settled"]);
  });

  it("acquireLock takes an advisory lock under pessimistic and none under optimistic", async () => {
    // The only observable difference between the two modes before a write
    // happens. A regression that dropped the `locking === "optimistic"` early
    // return would silently serialize every writer (making the
    // OptimisticConcurrencyError path unreachable), and no assertion on query
    // results would catch it.
    const advisoryLocks = async (tx: KyselyExecutor): Promise<number> => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND pid = pg_backend_pid()`.execute(tx);
      return rows[0]?.n ?? 0;
    };

    const pessimistic = createKyselyAdapter(db);
    await pessimistic.withTransaction(async (tx) => {
      expect(await advisoryLocks(tx)).toBe(0);
      await pessimistic.acquireLock(tx, MACHINE, "lock-probe");
      expect(await advisoryLocks(tx)).toBe(1);
    });

    const optimistic = createKyselyAdapter(db, { locking: "optimistic" });
    await optimistic.withTransaction(async (tx) => {
      await optimistic.acquireLock(tx, MACHINE, "lock-probe");
      expect(await advisoryLocks(tx)).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Custom tableName
// ─────────────────────────────────────────────────────────────────────────────

describe("tableName option", () => {
  it("runs the whole lifecycle against a custom table and leaves the default one alone", async () => {
    // Every statement in the adapter interpolates `sql.table(this.tableName)`.
    // One statement left on the default name would still pass the contract
    // suite (which only ever uses the default) while silently splitting a
    // subject's ledger across two tables.
    const adapter = createKyselyAdapter(db, { tableName: CUSTOM_LEDGER });

    const first = await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, "custom");
      return adapter.appendTransition(tx, newRow({ subjectId: "custom", toState: "pending" }));
    });
    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, "custom");
      await adapter.appendTransition(
        tx,
        newRow({ subjectId: "custom", fromState: "pending", toState: "settled", sortKey: 2 }),
      );
    });

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await adapter.readCurrent(rootExecutor(), MACHINE, "custom"))?.toState).toBe("settled");
    expect((await adapter.readHistory(null, MACHINE, "custom")).map((r) => r.toState)).toEqual([
      "pending",
      "settled",
    ]);
    expect(
      (await adapter.readStateAt(null, MACHINE, "custom", new Date(Date.now() + 60_000)))?.toState,
    ).toBe("settled");

    expect(await countLedgerRows(CUSTOM_LEDGER)).toBe(2);
    expect(await countLedgerRows(LEDGER)).toBe(0);

    // Rollback still works on the custom table (the advisory lock and the
    // partial unique index are per-table concerns).
    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, newRow({ subjectId: "custom-rb", toState: "pending" }));
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await countLedgerRows(CUSTOM_LEDGER)).toBe(2);
  });

  it("wraps a missing table in AdapterError rather than leaking the driver error", async () => {
    // A typo'd `tableName` is a configuration mistake, and callers filter on
    // AdapterError. Guards a read path that forgot its try/catch.
    const adapter = createKyselyAdapter(db, { tableName: "no_such_ledger_table" });
    await expect(adapter.readHistory(null, MACHINE, "x")).rejects.toBeInstanceOf(AdapterError);
    await expect(
      adapter.withTransaction(async (tx) => adapter.readCurrent(tx, MACHINE, "x")),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Identifier guard
// ─────────────────────────────────────────────────────────────────────────────

describe("assertValidIdentifier rejects instead of escaping", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["a double quote (would terminate a quoted identifier)", 'ledger" ; --'],
    ["a semicolon (statement separator)", "ledger; DROP TABLE payments"],
    ["a dot (would be read as a schema qualifier)", "public.ledger"],
    ["a leading digit (not a valid unquoted identifier)", "1_ledger"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a name longer than Postgres' 63-byte limit", "l".repeat(64)],
  ];

  for (const [label, name] of rejected) {
    it(`rejects a tableName with ${label}, before any query runs`, () => {
      // The guard is a boundary, not an escaping layer: these names must
      // never reach the database at all. `sql.table()` would happily quote
      // most of them (turning injection into a "relation does not exist"
      // error), but the over-long name is worse than that: Postgres truncates
      // it to 63 bytes without complaint, so the adapter would read and write
      // a *different* table than the one configured.
      expect(() => createKyselyAdapter(countingDb, { tableName: name })).toThrow(AdapterError);
      expect(counter.count).toBe(0);
    });
  }

  it("accepts a 63-character name and rejects 64 (the exact Postgres boundary)", () => {
    // Pins the boundary so it cannot drift in either direction: 63 bytes is
    // the longest identifier Postgres stores intact.
    expect(() => createKyselyAdapter(db, { tableName: "t".repeat(63) })).not.toThrow();
    expect(() => createKyselyAdapter(db, { tableName: "t".repeat(64) })).toThrow(AdapterError);
  });

  it("still accepts the identifiers real deployments use", () => {
    // Negative control for the tests above: the guard must not have become so
    // strict that ordinary namespaced table names stop working.
    for (const ok of ["stateledger_transitions", "_private", "Ledger2", "tenant_42_ledger"]) {
      expect(() => createKyselyAdapter(db, { tableName: ok })).not.toThrow();
    }
  });

  it("rejects bad model / column / where keys in updateSubjectState, before any query runs", async () => {
    // `updateSubjectState` interpolates three caller-supplied identifiers and
    // all three go through the same guard, which runs before the UPDATE is
    // built. So a hint carrying `state" = 'x'; --` can never be compiled, let
    // alone sent.
    const adapter = createKyselyAdapter(countingDb);
    const update = updateSubjectState(adapter);

    const badHints: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        "model with a semicolon",
        { model: "payments; DROP TABLE payments", where: { id: "pay-1" } },
      ],
      ["model with a dot", { model: "public.payments", where: { id: "pay-1" } }],
      ["model with a quote", { model: 'payments"', where: { id: "pay-1" } }],
      ["over-long model", { model: "p".repeat(64), where: { id: "pay-1" } }],
      ["column with a quote", { model: "payments", column: 'state"', where: { id: "pay-1" } }],
      [
        "column with a dot",
        { model: "payments", column: "payments.state", where: { id: "pay-1" } },
      ],
      ["where key with a quote", { model: "payments", where: { 'id"': "pay-1" } }],
      ["where key with a dot", { model: "payments", where: { "payments.id": "pay-1" } }],
      ["empty where key", { model: "payments", where: { "": "pay-1" } }],
    ];

    for (const [label, hint] of badHints) {
      await expect(
        update(countingDb, hint, "settled"),
        `expected ${label} to be rejected`,
      ).rejects.toBeInstanceOf(AdapterError);
    }
    expect(counter.count).toBe(0);

    // The row is untouched, which is the point: nothing executed.
    expect((await paymentRow("pay-1"))?.state).toBe("pending");
  });

  it("rejects a malformed hint shape before any query runs", async () => {
    // A missing `model` or `where` is a wiring mistake in the machine
    // definition. It has to fail loudly at the first transition instead of
    // compiling an UPDATE with no WHERE clause, which would rewrite the state
    // column of every row in the table.
    const adapter = createKyselyAdapter(countingDb);
    const update = updateSubjectState(adapter);

    const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["no model", { where: { id: "pay-1" } }],
      ["non-string model", { model: 42, where: { id: "pay-1" } }],
      ["no where", { model: "payments" }],
      ["non-object where", { model: "payments", where: "id = 'pay-1'" }],
      ["empty where", { model: "payments", where: {} }],
    ];

    for (const [label, hint] of malformed) {
      await expect(
        update(countingDb, hint, "settled"),
        `expected ${label} to be rejected`,
      ).rejects.toBeInstanceOf(AdapterError);
    }
    expect(counter.count).toBe(0);
    expect((await paymentRow("pay-2"))?.state).toBe("pending");

    // Control: the counter is live, so the zero-count assertions above mean
    // "nothing ran", not "the counter never counts anything".
    await adapter.withTransaction(async (tx) => {
      await update(tx, { model: "payments", where: { id: "pay-2" } }, "settled");
    });
    expect(counter.count).toBeGreaterThan(0);
    expect((await paymentRow("pay-2"))?.state).toBe("settled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. updateSubjectState against a real side table
// ─────────────────────────────────────────────────────────────────────────────

describe("updateSubjectState", () => {
  it("writes the denormalized state column and defaults the column name to `state`", async () => {
    const adapter = createKyselyAdapter(db);
    const update = updateSubjectState(adapter);

    await adapter.withTransaction(async (tx) => {
      await update(tx, { model: "payments", where: { id: "pay-1" } }, "settled");
    });

    expect((await paymentRow("pay-1"))?.state).toBe("settled");
    // Only the targeted row moved: guards a WHERE fragment that lost its
    // bindings and matched everything.
    expect((await paymentRow("pay-2"))?.state).toBe("pending");
    expect((await paymentRow("pay-3"))?.state).toBe("pending");
  });

  it("honours an explicit column and a multi-column where with mixed value types", async () => {
    // `sql.join` builds the WHERE from one fragment per key. A bug there (a
    // missing separator, or stringified booleans and numbers) only shows up
    // with more than one key and more than one JS type.
    const adapter = createKyselyAdapter(db);
    const update = updateSubjectState(adapter);

    await adapter.withTransaction(async (tx) => {
      await update(
        tx,
        { model: "payments", column: "shadow", where: { tenant_id: 42, live: true, id: "pay-1" } },
        "mirrored",
      );
    });

    expect(await paymentRow("pay-1")).toEqual({ state: "pending", shadow: "mirrored" });
    expect((await paymentRow("pay-2"))?.shadow).toBeNull();
    expect((await paymentRow("pay-3"))?.shadow).toBeNull();
  });

  it("keeps where VALUES as bound parameters, so SQL inside a value is inert", async () => {
    // The hazard: a subject id that came from user input. If any value were
    // concatenated into the statement this would drop the table. As a bound
    // parameter it is just a string that matches no row.
    const adapter = createKyselyAdapter(db);
    const update = updateSubjectState(adapter);
    const injection = "pay-1'; DROP TABLE payments; --";

    await adapter.withTransaction(async (tx) => {
      await update(tx, { model: "payments", where: { id: injection } }, "settled");
    });

    // Table still exists, and nothing matched.
    expect((await paymentRow("pay-1"))?.state).toBe("pending");
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM payments`.execute(db);
    expect(rows[0]?.n).toBe(3);

    // The new state is a bound parameter too: stored literally, not executed.
    const literal = "settled'; DROP TABLE payments; --";
    await adapter.withTransaction(async (tx) => {
      await update(tx, { model: "payments", where: { id: "pay-1" } }, literal);
    });
    expect((await paymentRow("pay-1"))?.state).toBe(literal);
  });

  it("silently matches nothing when the where hint identifies no row", async () => {
    // Documented (if blunt) behaviour: the adapter does not inspect the
    // affected-row count, so a hint pointing at a deleted or mistyped row is
    // a no-op rather than an error. Pinned so that a future decision to throw
    // on zero rows is deliberate and visible.
    const adapter = createKyselyAdapter(db);
    const update = updateSubjectState(adapter);

    await expect(
      adapter.withTransaction(async (tx) => {
        await update(tx, { model: "payments", where: { id: "nope" } }, "settled");
      }),
    ).resolves.toBeUndefined();

    expect((await paymentRow("pay-1"))?.state).toBe("pending");
  });

  it("wraps a column that does not exist in AdapterError", async () => {
    // A syntactically valid identifier that is not in the table: must arrive
    // as AdapterError naming the model and column, not as a raw pg error.
    const adapter = createKyselyAdapter(db);
    const update = updateSubjectState(adapter);

    await expect(
      adapter.withTransaction(async (tx) => {
        await update(tx, { model: "payments", column: "nonexistent", where: { id: "pay-1" } }, "x");
      }),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("rolls the side-table write back with the transition it accompanied", async () => {
    // The reason `updateSubjectState` takes the adapter's `tx` at all: the
    // denormalized column and the ledger must never disagree. If the update
    // ran on another connection, the payment would read "settled" with no
    // transition row to justify it.
    const adapter = createKyselyAdapter(db);
    const update = updateSubjectState(adapter);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, newRow({ subjectId: "pay-1", toState: "settled" }));
        await update(tx, { model: "payments", where: { id: "pay-1" } }, "settled");
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect((await paymentRow("pay-1"))?.state).toBe("pending");
    expect(await countLedgerRows()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Parameter binding fidelity
//    (the hazard class behind the postgres.js jsonb double-encoding bug in
//    @stateledger/pg and the raw-Date binding bug in @stateledger/drizzle)
// ─────────────────────────────────────────────────────────────────────────────

describe("parameter binding fidelity", () => {
  async function jsonbTypeOf(id: string): Promise<string | undefined> {
    const { rows } = await sql<{ t: string }>`
      SELECT jsonb_typeof(metadata) AS t FROM ${sql.table(LEDGER)} WHERE id = ${id}`.execute(db);
    return rows[0]?.t;
  }

  it("stores metadata as a jsonb object, not a double-encoded JSON string", async () => {
    // The bug class this guards: the adapter JSON.stringifies metadata and
    // casts the parameter with `::jsonb`. A driver that also encodes the value
    // on its own turns that into a jsonb *string* containing JSON, so reads
    // still "work" (JSON.parse of the text yields the object) while every
    // jsonb operator, index and `->>` query in the user's own SQL breaks.
    // `jsonb_typeof` is the only assertion that catches it.
    const adapter = createKyselyAdapter(db);

    const withData = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(
        tx,
        newRow({ subjectId: "jsonb-1", toState: "pending", metadata: { a: 1 } }),
      ),
    );
    const empty = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(
        tx,
        newRow({ subjectId: "jsonb-2", toState: "pending", metadata: {} }),
      ),
    );
    // `metadata: null` is outside the published type but reachable from plain
    // JS, and the adapter normalizes it with `?? {}`.
    const nulled = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(
        tx,
        newRow({
          subjectId: "jsonb-3",
          toState: "pending",
          metadata: null as unknown as Record<string, unknown>,
        }),
      ),
    );

    expect(await jsonbTypeOf(withData.id)).toBe("object");
    expect(await jsonbTypeOf(empty.id)).toBe("object");
    expect(await jsonbTypeOf(nulled.id)).toBe("object");
    expect(nulled.metadata).toEqual({});

    // And the value is queryable as jsonb, which a double-encoded column
    // would not be.
    const { rows } = await sql<{ a: string | null }>`
      SELECT metadata->>'a' AS a FROM ${sql.table(LEDGER)} WHERE id = ${withData.id}`.execute(db);
    expect(rows[0]?.a).toBe("1");
  });

  it("round-trips nested objects, arrays, unicode and snake_case keys faithfully", async () => {
    // Every read path re-parses `metadata::text`. This asserts the values that
    // round trip is there to protect: nothing re-shaped, re-keyed or mangled
    // by the driver or by a result plugin.
    const adapter = createKyselyAdapter(db);
    const metadata = {
      payment_intent: "pi_1",
      nested: { snake_key: "kept", deeper: { another_key: [1, 2, { leaf_key: true }] } },
      list: [{ in_array: "yes" }, null, 3],
      unicode: "café ☕ 日本語",
      quoted: 'he said "hi" \\ and left',
      empty_object: {},
      empty_list: [],
      zero: 0,
      falsy: false,
      nothing: null,
      big: 9007199254740991,
      float: 1.5,
    };

    const inserted = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(tx, newRow({ subjectId: "fidelity", toState: "pending", metadata })),
    );
    expect(inserted.metadata).toEqual(metadata);

    // All three read paths, because each maps its own result rows.
    const current = await adapter.readCurrent(rootExecutor(), MACHINE, "fidelity");
    const [historical] = await adapter.readHistory(null, MACHINE, "fidelity");
    const at = await adapter.readStateAt(null, MACHINE, "fidelity", new Date(Date.now() + 60_000));
    expect(current?.metadata).toEqual(metadata);
    expect(historical?.metadata).toEqual(metadata);
    expect(at?.metadata).toEqual(metadata);
  });

  it("surfaces a NUL byte in metadata as AdapterError instead of a half-written ledger", async () => {
    // Postgres' jsonb type cannot hold a \u0000 escape, so metadata sourced from
    // binary-ish user input fails the INSERT. Pinned because the failure must
    // arrive as a wrapped AdapterError on the transition (the caller sees a
    // failed transition and sanitizes or retries) and must leave no row.
    const adapter = createKyselyAdapter(db);
    await expect(
      adapter.withTransaction(async (tx) =>
        adapter.appendTransition(
          tx,
          newRow({ subjectId: "nul", toState: "pending", metadata: { raw: "a\u0000b" } }),
        ),
      ),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(await countLedgerRows()).toBe(0);
  });

  it("readStateAt accepts a real JS Date as the cutoff", async () => {
    // The exact shape of the bug found in @stateledger/drizzle: `created_at
    // <= ${at}` binds a JS `Date`, and a driver that will not encode a Date
    // for a timestamptz parameter throws at query time. Invisible unless a
    // test passes a real Date (not an ISO string) through the adapter.
    const adapter = createKyselyAdapter(db);

    const first = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(tx, newRow({ subjectId: "timetravel", toState: "pending" })),
    );
    // Real clock gap: created_at comes from NOW() at microsecond precision
    // while JS Dates are millisecond-truncated, so two inserts inside one
    // millisecond would make the cutoff ambiguous rather than wrong.
    await sleep(60);
    const cutoff = new Date();
    await sleep(60);
    const second = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(
        tx,
        newRow({ subjectId: "timetravel", fromState: "pending", toState: "settled", sortKey: 2 }),
      ),
    );

    expect((await adapter.readStateAt(null, MACHINE, "timetravel", cutoff))?.id).toBe(first.id);
    expect(
      (await adapter.readStateAt(null, MACHINE, "timetravel", new Date(Date.now() + 60_000)))?.id,
    ).toBe(second.id);
    expect(
      await adapter.readStateAt(
        null,
        MACHINE,
        "timetravel",
        new Date(first.createdAt.getTime() - 60_000),
      ),
    ).toBeNull();

    // `createdAt` must come back as a Date, not the driver's string form:
    // `mapRow` normalizes it and callers do date arithmetic on it.
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
  });

  it("round-trips integer columns as numbers, including INTEGER max", async () => {
    // `sortKey` and `machineVersion` are INTEGER, and `mapRow` wraps both in
    // Number() because a pg instance configured with a bigint parser hands
    // back strings. Guards a `sortKey` arriving as "2147483647" and then
    // sorting lexicographically everywhere it is compared.
    const adapter = createKyselyAdapter(db);
    const inserted = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(
        tx,
        newRow({
          subjectId: "ints",
          toState: "pending",
          sortKey: 2_147_483_647,
          machineVersion: 2_147_483_647,
        }),
      ),
    );

    expect(inserted.sortKey).toBe(2_147_483_647);
    expect(inserted.machineVersion).toBe(2_147_483_647);
    expect(typeof inserted.sortKey).toBe("number");
    expect(typeof inserted.machineVersion).toBe("number");

    const current = await adapter.readCurrent(rootExecutor(), MACHINE, "ints");
    expect(current?.sortKey).toBe(2_147_483_647);
    expect(current?.machineVersion).toBe(2_147_483_647);
  });

  it("round-trips nullable columns and awkward state names", async () => {
    // from_state is null on the bootstrap transition and actor_* are null for
    // system-driven transitions; a projection that coalesced them would hide
    // "who did this". State names with quotes and accents must survive being
    // bound, since they are user-chosen strings.
    const adapter = createKyselyAdapter(db);
    const weirdState = "état_payé'\"; --";
    const inserted = await adapter.withTransaction(async (tx) =>
      adapter.appendTransition(
        tx,
        newRow({
          subjectId: "nulls",
          toState: weirdState,
          fromState: null,
          actorId: null,
          actorType: null,
        }),
      ),
    );

    expect(inserted.fromState).toBeNull();
    expect(inserted.actorId).toBeNull();
    expect(inserted.actorType).toBeNull();
    expect(inserted.toState).toBe(weirdState);

    const current = await adapter.readCurrent(rootExecutor(), MACHINE, "nulls");
    expect(current).toEqual(inserted);
  });

  it("keeps subject ids with SQL metacharacters bound, not interpolated", async () => {
    // Subject ids are user data (order numbers, external ids). They flow into
    // the advisory-lock key and every WHERE clause, and two subjects whose ids
    // differ only in punctuation must stay separate ledgers.
    const adapter = createKyselyAdapter(db);
    const nasty = "sub'); DROP TABLE stateledger_transitions; --";

    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, nasty);
      await adapter.appendTransition(tx, newRow({ subjectId: nasty, toState: "pending" }));
    });

    expect((await adapter.readCurrent(rootExecutor(), MACHINE, nasty))?.subjectId).toBe(nasty);
    expect(await adapter.readHistory(null, MACHINE, "sub")).toEqual([]);
    expect(await countLedgerRows()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Rows written by something other than this adapter
// ─────────────────────────────────────────────────────────────────────────────

describe("metadata written outside the adapter", () => {
  async function insertRaw(subjectId: string, metadataLiteral: string): Promise<void> {
    await sql`
      INSERT INTO ${sql.table(LEDGER)}
        (machine, subject_id, to_state, sort_key, most_recent, metadata, machine_version)
      VALUES (${MACHINE}, ${subjectId}, 'pending', 1, TRUE, ${sql.raw(metadataLiteral)}::jsonb, 1)`.execute(
      db,
    );
  }

  it("rejects non-object metadata instead of handing back a lie", async () => {
    // jsonb happily holds arrays and scalars, and a migration or another
    // service can write them. Returning one as `Record<string, unknown>` would
    // type-check and then explode somewhere far away, so the adapter validates
    // on read.
    const adapter = createKyselyAdapter(db);

    await insertRaw("raw-array", "'[1,2,3]'");
    await expect(adapter.readHistory(null, MACHINE, "raw-array")).rejects.toBeInstanceOf(
      AdapterError,
    );

    await insertRaw("raw-scalar", "'42'");
    await expect(adapter.readHistory(null, MACHINE, "raw-scalar")).rejects.toBeInstanceOf(
      AdapterError,
    );

    await insertRaw("raw-string", `'"a string"'`);
    await expect(adapter.readHistory(null, MACHINE, "raw-string")).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it("treats JSON null metadata as an empty object", async () => {
    // `'null'::jsonb` satisfies the NOT NULL constraint, so it is reachable.
    // Normalizing it to {} keeps `row.metadata.x` from throwing in every
    // caller that never considered the case.
    const adapter = createKyselyAdapter(db);
    await insertRaw("raw-null", "'null'");

    const [row] = await adapter.readHistory(null, MACHINE, "raw-null");
    expect(row?.metadata).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Rollback completeness
// ─────────────────────────────────────────────────────────────────────────────

describe("rollback leaves nothing behind", () => {
  it("undoes the most_recent flip as well as the insert", async () => {
    // `appendTransition` does two writes: it clears the previous mostRecent
    // row and inserts the new one. A rollback that only lost the insert would
    // leave a subject with NO current row, so readCurrent returns null and the
    // machine thinks the subject never existed. The contract suite cannot see
    // this: it rolls back a bootstrap transition, where there is no previous
    // row to flip.
    const adapter = createKyselyAdapter(db);

    const first = await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, "rb");
      return adapter.appendTransition(tx, newRow({ subjectId: "rb", toState: "pending" }));
    });

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "rb");
        await adapter.appendTransition(
          tx,
          newRow({ subjectId: "rb", fromState: "pending", toState: "settled", sortKey: 2 }),
        );
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    const current = await adapter.readCurrent(rootExecutor(), MACHINE, "rb");
    expect(current?.id).toBe(first.id);
    expect(current?.mostRecent).toBe(true);
    expect(await countLedgerRows()).toBe(1);

    // And the subject is still writable afterwards: the advisory lock was
    // released by the rollback and sort_key 2 is free again.
    const retried = await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, "rb");
      return adapter.appendTransition(
        tx,
        newRow({ subjectId: "rb", fromState: "pending", toState: "settled", sortKey: 2 }),
      );
    });
    expect(retried.mostRecent).toBe(true);
    expect((await adapter.readHistory(null, MACHINE, "rb")).map((r) => r.toState)).toEqual([
      "pending",
      "settled",
    ]);
  });

  it("re-throws the caller's own error rather than a wrapped one", async () => {
    // Rollback must be transparent: callers match on their own error types (a
    // GuardRejected from a machine guard, a domain error from an `after:`
    // hook). Kysely's TransactionBuilder re-throws the original, and the
    // adapter must not catch and wrap it on the way out.
    const adapter = createKyselyAdapter(db);
    const sentinel = new Rollback();

    await expect(
      adapter.withTransaction(async () => {
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
  });

  it("hands a clean connection back to the pool after a rollback", async () => {
    // Connection hygiene: after a rolled-back transaction the connection goes
    // back to the pool, and a missed ROLLBACK would leave the next user of
    // that connection writing inside an aborted transaction (every statement
    // failing with 25P02). Writing again immediately proves it is clean.
    const adapter = createKyselyAdapter(db);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, newRow({ subjectId: "hygiene", toState: "pending" }));
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    await adapter.withTransaction(async (tx) => {
      await adapter.appendTransition(tx, newRow({ subjectId: "hygiene", toState: "settled" }));
    });

    expect((await adapter.readCurrent(rootExecutor(), MACHINE, "hygiene"))?.toState).toBe(
      "settled",
    );
    expect(await countLedgerRows()).toBe(1);
  });
});
