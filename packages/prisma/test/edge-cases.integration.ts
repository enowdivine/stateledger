/**
 * Edge-case integration suite for the Prisma adapter.
 *
 * The shared `runContractTests` pack proves the happy path through a root
 * `PrismaClient` in pessimistic mode. Everything in this file is the stuff
 * that pack cannot see: the caller-supplied-transaction client, optimistic
 * locking, a non-default table name, what the metadata column actually holds
 * at rest, and the `Date` and `where`-value parameters whose serialization
 * depends on the driver underneath.
 *
 * That last group is why this file exists. Two sibling adapters shipped a bug
 * of exactly that shape: `@stateledger/pg` bound a pre-stringified JSON
 * string to a `::jsonb` parameter and postgres.js serialized it a second
 * time, so a jsonb *scalar string* holding JSON text landed in the column
 * instead of a jsonb object, and `@stateledger/drizzle` bound a raw `Date`
 * that node-postgres accepted and postgres.js rejected outright, which broke
 * `readStateAt` on that flavor for two releases without anyone noticing.
 * Both slipped through 12-test contract suites that read their own writes
 * back through the same adapter, which is a mirror and not a measurement.
 *
 * So the metadata tests here go behind the adapter and ask Postgres what is
 * in the column (`jsonb_typeof`, `metadata::text`), and the `readStateAt`
 * tests pin rows to known instants with explicit SQL rather than trusting
 * round-tripping to reveal an offset.
 *
 * Prisma has exactly one driver path | the Rust query engine | so unlike the
 * Drizzle package there is no second flavor to run this against. What the
 * audit behind this file established empirically about that path:
 *
 *   - A JS string parameter is declared to Postgres as `text` (verified with
 *     `SELECT pg_typeof($1)` -> `text`). So `$9::jsonb` in `appendTransition`
 *     is a real server-side text-to-jsonb cast, which is the same shape as
 *     the `$n::text::jsonb` fix applied to `@stateledger/pg`. The engine
 *     never re-serializes a parameter based on the OID the server describes,
 *     which is the behaviour that bit postgres.js, so the double-encoding
 *     bug cannot occur on this path.
 *   - A JS `Date` is declared as `timestamptz` (ISO-8601 UTC on the wire via
 *     the engine's `{ prisma__type: "date" }` envelope), so it is an instant
 *     and not a wall-clock reading. Verified under a non-UTC session
 *     timezone, where a naive-timestamp binding would have shifted by hours.
 *
 * Run locally:
 *   pnpm --filter @stateledger/prisma exec prisma generate \\
 *     --schema test/prisma/schema.prisma
 *   pnpm --filter @stateledger/prisma test:integration
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import type { Adapter, NewTransitionRow } from "@stateledger/core";

import { PrismaClient } from "../node_modules/.prisma/test-client/index.js";
import { createPrismaAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";
import type { PrismaRawCalls } from "../src/types.js";

const MACHINE = "edge-machine";
const DEFAULT_TABLE = "stateledger_transitions";
const CUSTOM_TABLE = "tenant_acme_transitions";
const SUBJECTS_TABLE = "edge_subjects";

/** A subject id that would drop a table if it were ever interpolated. */
const INJECTION_ID = `x'; DROP TABLE "${SUBJECTS_TABLE}"; --`;

let container: StartedTestContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    // Wait for Postgres to actually accept connections (2nd log occurrence).
    // See the contract integration test for the full explanation.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const url =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  prisma = new PrismaClient({ datasources: { db: { url } } });

  // Prisma's $executeRawUnsafe rejects multi-statement scripts, so each DDL
  // statement goes over on its own.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await prisma.$executeRawUnsafe(stmt);
  }

  // The same schema under a second table name, for the custom-tableName test.
  // Index names are rewritten along with the table name so the two schemas
  // can coexist in one database.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await prisma.$executeRawUnsafe(stmt.replaceAll(DEFAULT_TABLE, CUSTOM_TABLE));
  }

  // Stand-in for a user's own domain table, the target of updateSubjectState.
  // Two identifying columns, because the adapter builds a multi-column WHERE
  // and the parameter numbering there ($2..$N after $1 = newState) is its own
  // opportunity for an off-by-one.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${SUBJECTS_TABLE}" (
       id      TEXT NOT NULL,
       tenant  TEXT NOT NULL,
       state   TEXT NOT NULL,
       PRIMARY KEY (id, tenant)
     )`,
  );
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "${DEFAULT_TABLE}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE "${CUSTOM_TABLE}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE "${SUBJECTS_TABLE}"`);
  // Three subjects: two legitimate rows that share an id across tenants (so
  // a WHERE that drops a column would be caught), plus the injection probe.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${SUBJECTS_TABLE}" (id, tenant, state) VALUES
       ('pay_1', 'acme',   'pending'),
       ('pay_1', 'globex', 'pending'),
       ($1,      'acme',   'pending')`,
    INJECTION_ID,
  );
});

// ---- helpers ----

function buildRow(
  overrides: Partial<NewTransitionRow> & { toState: string },
): NewTransitionRow {
  return {
    machine: MACHINE,
    subjectId: "subject-1",
    fromState: null,
    sortKey: 1,
    mostRecent: true,
    actorId: "test",
    actorType: "SYSTEM",
    metadata: {},
    machineVersion: 1,
    ...overrides,
  };
}

/**
 * Read rows with the raw client, bypassing the adapter.
 *
 * Every assertion about what is *at rest* has to come through here. Reading a
 * value back through the same adapter that wrote it can hide a symmetric
 * encoding bug, which is exactly how the sibling adapters' jsonb corruption
 * stayed invisible.
 */
async function raw<T>(query: string, ...values: unknown[]): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(query, ...values);
}

async function countRows(table: string, where = "TRUE"): Promise<number> {
  // COUNT(*) is bigint and Prisma hands bigints back as BigInt, so cast to
  // int in SQL and keep the assertion a plain number comparison.
  const rows = await raw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${where}`,
  );
  return first(rows).n;
}

/** Index access with a real failure message, since `noUncheckedIndexedAccess` is on. */
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row, got none");
  return row;
}

async function advisoryLockCount(): Promise<number> {
  const rows = await raw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
  );
  return first(rows).n;
}

/**
 * Call the adapter's `updateSubjectState`, asserting it exists first.
 *
 * Core declares the hook optional (`updateSubjectState?`) because an adapter
 * is allowed not to support the `subjectStateColumn` denormalization, so TS
 * sees it as possibly undefined at every call site. Both published Postgres
 * adapters do implement it, and funnelling the calls through here says so
 * once | with a real failure message if that ever stops being true | instead
 * of scattering optional-call syntax that would silently skip the test.
 */
async function updateSubjectState(
  adapter: Adapter<PrismaRawCalls>,
  tx: PrismaRawCalls,
  hint: Record<string, unknown>,
  newState: string,
): Promise<void> {
  const hook = adapter.updateSubjectState;
  if (!hook) {
    throw new Error("adapter does not implement the optional updateSubjectState hook");
  }
  return hook.call(adapter, tx, hint, newState);
}

function onlyRejection(results: PromiseSettledResult<unknown>[]): unknown {
  const rejected = results.filter((r) => r.status === "rejected");
  expect(rejected).toHaveLength(1);
  return (rejected[0] as PromiseRejectedResult).reason;
}

describe("PrismaAdapter edge cases (real Postgres)", () => {
  // ── Joining a transaction the caller already opened ────────

  it("joins a caller-supplied transaction client instead of opening its own", async () => {
    // `createPrismaAdapter` accepts a `Prisma.TransactionClient` so a
    // transition can be one step inside a larger business transaction. That
    // path is structurally different from the documented one: the adapter's
    // `hasTransactionMethod` probe decides between `$transaction(...)` and
    // "run the callback on what I was given", and getting it wrong here means
    // either a nested-transaction error from Prisma or, worse, silently
    // committing the transition on a separate connection while the caller's
    // transaction rolls back.
    const trap = new Error("caller rolled back");

    await expect(
      prisma.$transaction(async (itx) => {
        // Prisma strips `$transaction` from the interactive-transaction client
        // at runtime, not just from its types (the ITX denylist), which is
        // what makes the probe land on the join branch.
        expect((itx as { $transaction?: unknown }).$transaction).toBeUndefined();

        const joined = createPrismaAdapter(itx);
        await joined.withTransaction(async (tx) => {
          await joined.acquireLock(tx, MACHINE, "joined");
          await joined.appendTransition(
            tx,
            buildRow({ subjectId: "joined", toState: "pending" }),
          );
          // Visible to the caller's own transaction...
          const inside = await joined.readCurrent(tx, MACHINE, "joined");
          expect(inside?.toState).toBe("pending");
        });

        // ...and invisible outside it. This is the assertion that proves the
        // write really went onto the caller's transaction rather than onto a
        // second connection the adapter opened behind its back.
        const outside = await raw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM "${DEFAULT_TABLE}" WHERE subject_id = 'joined'`,
        );
        expect(first(outside).n).toBe(0);

        throw trap;
      }),
    ).rejects.toThrow("caller rolled back");

    // The caller rolled back, so the transition must be gone.
    expect(await countRows(DEFAULT_TABLE, "subject_id = 'joined'")).toBe(0);
  });

  it("lets a caller-supplied transaction commit the transition it joined", async () => {
    // The mirror of the rollback case. Without this, an adapter that quietly
    // dropped the write would still pass the test above.
    await prisma.$transaction(async (itx) => {
      const joined = createPrismaAdapter(itx);
      await joined.withTransaction(async (tx) => {
        await joined.acquireLock(tx, MACHINE, "joined-commit");
        await joined.appendTransition(
          tx,
          buildRow({ subjectId: "joined-commit", toState: "pending" }),
        );
      });
    });

    const rootAdapter = createPrismaAdapter(prisma);
    const history = await rootAdapter.readHistory(null, MACHINE, "joined-commit");
    expect(history.map((r) => r.toState)).toEqual(["pending"]);
  });

  it("readHistory and readStateAt see a caller transaction's uncommitted writes when handed its tx", async () => {
    // The read paths take `tx | null`. Passing `null` reads outside any
    // transaction, which for a caller mid-transaction would mean reading
    // stale data; passing the tx must read through it.
    await prisma.$transaction(async (itx) => {
      const joined = createPrismaAdapter(itx);
      await joined.withTransaction(async (tx) => {
        await joined.acquireLock(tx, MACHINE, "joined-read");
        await joined.appendTransition(
          tx,
          buildRow({ subjectId: "joined-read", toState: "pending" }),
        );

        const viaTx = await joined.readHistory(tx, MACHINE, "joined-read");
        expect(viaTx).toHaveLength(1);

        const atNow = await joined.readStateAt(tx, MACHINE, "joined-read", new Date());
        expect(atNow?.toState).toBe("pending");
      });
      // Roll back so the row never reaches the next test.
      throw new Error("discard");
    }).catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== "discard") throw err;
    });

    expect(await countRows(DEFAULT_TABLE, "subject_id = 'joined-read'")).toBe(0);
  });

  // ── locking: "optimistic" ─────────────────────────────────

  it("optimistic locking surfaces exactly one winner and an OptimisticConcurrencyError for the loser", async () => {
    // Optimistic mode makes `acquireLock` a no-op and leans entirely on the
    // partial unique index to catch a lost race. The thing under test is the
    // error *class*: the loser has to come back as OptimisticConcurrencyError,
    // because that is what callers retry on. Prisma reports a raw-query
    // constraint violation as `PrismaClientKnownRequestError` with code P2010
    // and the SQLSTATE buried in `meta.code`, NOT as the P2002 that mapped
    // model calls produce, so `isUniqueViolation` has to read that nested
    // shape. If it ever stops doing so, the loser degrades to a generic
    // AdapterError, retry loops stop firing, and the failure looks like a
    // random 500 under load.
    const adapter = createPrismaAdapter(prisma, { locking: "optimistic" });
    const subjectId = "race-1";

    // Bootstrap row, so both writers race to append the *second* transition |
    // the realistic shape of an optimistic retry.
    await adapter.withTransaction(async (tx) => {
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId, toState: "pending", sortKey: 1 }),
      );
    });

    const attempt = (toState: string) =>
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, subjectId);
        const current = await adapter.readCurrent(tx, MACHINE, subjectId);
        expect(current).not.toBeNull();
        // Both writers read the same current row before either writes, which
        // is the race optimistic locking exists to detect.
        await new Promise((resolve) => setTimeout(resolve, 30));
        await adapter.appendTransition(
          tx,
          buildRow({
            subjectId,
            fromState: current?.toState ?? null,
            toState,
            sortKey: (current?.sortKey ?? 0) + 1,
          }),
        );
      });

    const results = await Promise.allSettled([
      attempt("authorized"),
      attempt("cancelled"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const reason = onlyRejection(results);
    expect(reason).toBeInstanceOf(OptimisticConcurrencyError);
    // Specifically not the catch-all wrapper | callers match on the subclass.
    expect(reason).not.toBeInstanceOf(AdapterError);
    const conflict = reason as OptimisticConcurrencyError;
    expect(conflict.machine).toBe(MACHINE);
    expect(conflict.subjectId).toBe(subjectId);

    // The loser's transaction rolled back whole: two rows total (bootstrap +
    // winner) and exactly one of them most_recent.
    expect(await countRows(DEFAULT_TABLE, `subject_id = '${subjectId}'`)).toBe(2);
    expect(
      await countRows(DEFAULT_TABLE, `subject_id = '${subjectId}' AND most_recent = TRUE`),
    ).toBe(1);
  });

  it("takes an advisory lock in pessimistic mode and none in optimistic mode", async () => {
    // `acquireLock` must be a no-op in optimistic mode. If it still took
    // `pg_advisory_xact_lock`, optimistic mode would quietly behave like
    // pessimistic mode and the race above would never actually race, which
    // would make that test pass for the wrong reason forever.
    //
    // The lock count is read from `pg_locks` on a *different* connection
    // (Prisma pools, and an interactive transaction holds one of its own), so
    // the query cannot filter by `pg_backend_pid()` | it counts every advisory
    // lock in the cluster instead. That is sound here because the suite runs
    // sequentially against a private container, so the only advisory lock
    // that can exist is the one under test.
    const optimistic = createPrismaAdapter(prisma, { locking: "optimistic" });
    await optimistic.withTransaction(async (tx) => {
      await optimistic.acquireLock(tx, MACHINE, "lock-probe");
      expect(await advisoryLockCount()).toBe(0);
    });

    const pessimistic = createPrismaAdapter(prisma);
    await pessimistic.withTransaction(async (tx) => {
      await pessimistic.acquireLock(tx, MACHINE, "lock-probe");
      expect(await advisoryLockCount()).toBe(1);
    });

    // Advisory *xact* locks release with the transaction, with no explicit
    // unlock call | that is the whole reason the adapter uses the xact variant
    // rather than `pg_advisory_lock`, which would leak a lock per transition
    // and eventually wedge the subject for the lifetime of the connection.
    expect(await advisoryLockCount()).toBe(0);
  });

  // ── Custom tableName ──────────────────────────────────────

  it("writes and reads every path through a custom tableName", async () => {
    // `tableName` is interpolated into raw SQL in nine different statements.
    // A single one left hardcoded would pass the contract suite (it runs
    // against the default name) and corrupt a tenant-namespaced deployment.
    const adapter = createPrismaAdapter(prisma, { tableName: CUSTOM_TABLE });
    const subjectId = "custom-1";

    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId, toState: "pending", sortKey: 1, metadata: { a: 1 } }),
      );
    });
    await adapter.withTransaction(async (tx) => {
      await adapter.acquireLock(tx, MACHINE, subjectId);
      const current = await adapter.readCurrent(tx, MACHINE, subjectId);
      expect(current?.toState).toBe("pending");
      await adapter.appendTransition(
        tx,
        buildRow({ subjectId, fromState: "pending", toState: "authorized", sortKey: 2 }),
      );
    });

    const history = await adapter.readHistory(null, MACHINE, subjectId);
    expect(history.map((r) => r.toState)).toEqual(["pending", "authorized"]);

    const at = await adapter.readStateAt(null, MACHINE, subjectId, new Date());
    expect(at?.toState).toBe("authorized");

    // Landed in the custom table, and nothing leaked into the default one.
    expect(await countRows(CUSTOM_TABLE)).toBe(2);
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("rejects a tableName that is not a bare SQL identifier", async () => {
    // The table name reaches raw SQL by interpolation, so the identifier
    // allowlist is the only thing between a caller's config and injection.
    // Failing at construction time (not at first query) is the point.
    expect(() =>
      createPrismaAdapter(prisma, { tableName: `t"; DROP TABLE "${SUBJECTS_TABLE}"; --` }),
    ).toThrow(AdapterError);
    expect(() => createPrismaAdapter(prisma, { tableName: "has-a-dash" })).toThrow(
      AdapterError,
    );

    expect(await countRows(SUBJECTS_TABLE)).toBe(3);
  });

  // ── Metadata fidelity at rest ─────────────────────────────

  describe("metadata fidelity at rest", () => {
    // These are the regression tests for the `@stateledger/pg` bug: a
    // pre-stringified JSON string bound to a `::jsonb` parameter and
    // serialized a second time by the driver, which stores a jsonb scalar
    // string holding JSON text. Round-tripping through the adapter alone
    // cannot tell the two apart in every case, so each test asks Postgres
    // what the column actually holds.
    const cases: Array<{ name: string; metadata: Record<string, unknown> }> = [
      { name: "a nested object", metadata: { outer: { inner: { depth: 3 } } } },
      { name: "an array", metadata: { tags: ["a", "b"], mixed: [1, null, { x: true }] } },
      { name: "a unicode value", metadata: { note: "café ☕ 北京 🚀" } },
      { name: "a value with quotes and backslashes", metadata: { note: 'he said "hi" \\ bye' } },
      { name: "a key containing an underscore", metadata: { with_underscore: "ok", nested_key: { also_under: 1 } } },
      { name: "an empty object", metadata: {} },
      { name: "numbers at the edges of JS precision", metadata: { big: 9007199254740991, float: -1.5, zero: 0 } },
    ];

    for (const [index, testCase] of cases.entries()) {
      it(`stores ${testCase.name} as a jsonb object that round-trips`, async () => {
        const adapter = createPrismaAdapter(prisma);
        const subjectId = `meta-${index}`;

        const inserted = await adapter.withTransaction(async (tx) => {
          await adapter.acquireLock(tx, MACHINE, subjectId);
          return adapter.appendTransition(
            tx,
            buildRow({ subjectId, toState: "pending", metadata: testCase.metadata }),
          );
        });

        // What the INSERT ... RETURNING handed back.
        expect(inserted.metadata).toEqual(testCase.metadata);

        // What is in the column, as Postgres sees it. `jsonb_typeof` is the
        // assertion that catches double-encoding: a doubly-serialized value
        // reports 'string' here, never 'object'.
        const rows = await raw<{ kind: string; text: string }>(
          `SELECT jsonb_typeof(metadata) AS kind, metadata::text AS text
             FROM "${DEFAULT_TABLE}" WHERE subject_id = $1`,
          subjectId,
        );
        const row = first(rows);
        expect(row.kind).toBe("object");
        expect(JSON.parse(row.text)).toEqual(testCase.metadata);

        // And what a fresh read returns, on a new connection.
        const history = await adapter.readHistory(null, MACHINE, subjectId);
        expect(first(history).metadata).toEqual(testCase.metadata);
      });
    }

    it("keeps a JSON-looking string value a string", async () => {
      // The sharpest form of the double-encoding check. If anything in the
      // chain re-parses or re-serializes metadata, this value either becomes
      // a nested object or gains a layer of escaping. It has to come back
      // byte-identical, and `jsonb_typeof` on the member has to say 'string'.
      const metadata = { payload: '{"not":"parsed"}', empty: "" };
      const adapter = createPrismaAdapter(prisma);

      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(
          tx,
          buildRow({ subjectId: "meta-json-string", toState: "pending", metadata }),
        );
      });

      const rows = await raw<{ outer: string; member: string; value: string }>(
        `SELECT jsonb_typeof(metadata) AS outer,
                jsonb_typeof(metadata -> 'payload') AS member,
                metadata ->> 'payload' AS value
           FROM "${DEFAULT_TABLE}" WHERE subject_id = 'meta-json-string'`,
      );
      const row = first(rows);
      expect(row.outer).toBe("object");
      expect(row.member).toBe("string");
      expect(row.value).toBe('{"not":"parsed"}');

      const history = await adapter.readHistory(null, MACHINE, "meta-json-string");
      expect(first(history).metadata).toEqual(metadata);
    });

    it("defaults null metadata to an empty jsonb object on write", async () => {
      // Core types metadata as non-nullable, but JS callers reach the adapter
      // untyped and the adapter explicitly defends with `row.metadata ?? {}`.
      // Casting through `unknown` is the only way to exercise that defence |
      // there is no way to type a null into a non-nullable field.
      const rowWithNullMetadata = {
        ...buildRow({ subjectId: "meta-null", toState: "pending" }),
        metadata: null,
      } as unknown as NewTransitionRow;

      const adapter = createPrismaAdapter(prisma);
      const inserted = await adapter.withTransaction(async (tx) =>
        adapter.appendTransition(tx, rowWithNullMetadata),
      );
      expect(inserted.metadata).toEqual({});

      const rows = await raw<{ kind: string }>(
        `SELECT jsonb_typeof(metadata) AS kind FROM "${DEFAULT_TABLE}" WHERE subject_id = 'meta-null'`,
      );
      expect(first(rows).kind).toBe("object");
    });

    it("maps a SQL NULL in the metadata column to an empty object on read", async () => {
      // The column is NOT NULL in our recommended schema, but adapters get
      // pointed at pre-existing tables where it is nullable, and `mapRow`
      // promises `metadata` is always an object. Force a NULL in and check.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${DEFAULT_TABLE}" ALTER COLUMN metadata DROP NOT NULL`,
      );
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${DEFAULT_TABLE}" (machine, subject_id, to_state, sort_key, metadata)
             VALUES ($1, 'meta-sql-null', 'pending', 1, NULL)`,
          MACHINE,
        );
        const adapter = createPrismaAdapter(prisma);
        const history = await adapter.readHistory(null, MACHINE, "meta-sql-null");
        expect(first(history).metadata).toEqual({});
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "${DEFAULT_TABLE}" WHERE subject_id = 'meta-sql-null'`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "${DEFAULT_TABLE}" ALTER COLUMN metadata SET NOT NULL`,
        );
      }
    });
  });

  // ── readStateAt with a real Date cutoff ───────────────────

  describe("readStateAt with a real Date cutoff", () => {
    // Regression tests for the second bug in the class: `@stateledger/drizzle`
    // bound a raw `Date` to the cutoff parameter, which node-postgres
    // serialized itself and postgres.js refused outright with
    // `The "string" argument must be of type string ... Received an instance
    // of Date`, so time travel was broken on that flavor from v0.2.0. Prisma
    // has one driver path and the audit confirmed it declares a Date as
    // `timestamptz`, which is an instant rather than a wall-clock reading.
    // These tests are what keeps that true.

    /** Pin rows to known instants, bypassing the column's NOW() default. */
    async function seedAtInstants(subjectId: string): Promise<void> {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${DEFAULT_TABLE}"
           (machine, subject_id, from_state, to_state, sort_key, most_recent, created_at)
         VALUES
           ($1, $2, NULL,         'pending',    1, FALSE, '2026-03-01T11:00:00Z'),
           ($1, $2, 'pending',    'authorized', 2, FALSE, '2026-03-01T12:00:00Z'),
           ($1, $2, 'authorized', 'captured',   3, TRUE,  '2026-03-01T13:00:00Z')`,
        MACHINE,
        subjectId,
      );
    }

    it("resolves a cutoff between two known instants", async () => {
      const adapter = createPrismaAdapter(prisma);
      await seedAtInstants("tt-1");

      const mid = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-1",
        new Date("2026-03-01T12:30:00Z"),
      );
      expect(mid?.toState).toBe("authorized");

      const late = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-1",
        new Date("2026-03-01T13:00:00.001Z"),
      );
      expect(late?.toState).toBe("captured");

      const early = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-1",
        new Date("2026-03-01T10:59:59Z"),
      );
      expect(early).toBeNull();
    });

    it("resolves the same row for one instant written in two timezones", async () => {
      // The cutoffs sit one minute either side of a stored instant, so any
      // whole-hour shift in how the parameter is interpreted flips an
      // assertion. The third cutoff is the same instant as the first written
      // with a +09:00 offset instead of Z, which proves the offset is honoured
      // rather than parsed away.
      const adapter = createPrismaAdapter(prisma);
      await seedAtInstants("tt-2");

      const justAfter = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-2",
        new Date("2026-03-01T12:01:00Z"),
      );
      expect(justAfter?.toState).toBe("authorized");

      const justBefore = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-2",
        new Date("2026-03-01T11:59:00Z"),
      );
      expect(justBefore?.toState).toBe("pending");

      // 21:01 in Tokyo is 12:01 UTC: same instant, different wall clock.
      const sameInstantOtherZone = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-2",
        new Date("2026-03-01T21:01:00+09:00"),
      );
      expect(sameInstantOtherZone?.toState).toBe("authorized");
    });

    it("treats the cutoff as an instant on a connection whose session timezone is not UTC", async () => {
      // This is the real guard against a naive-timestamp binding, and the
      // reason it needs its own session: the test container runs in UTC, so a
      // cutoff that lost its timezone would still compare correctly there and
      // the suite would be blind to it. `SET LOCAL TIME ZONE` inside an
      // interactive transaction pins the session for exactly the connection
      // the adapter then reads on, and under Asia/Tokyo a cutoff that Postgres
      // has to interpret as wall-clock lands nine hours out | far enough to
      // flip both assertions below, which sit one minute either side of a
      // stored instant.
      //
      // Prisma's engine declares a JS `Date` parameter as `timestamptz`, so
      // the instant survives. The sibling Drizzle adapter had to bind
      // `at.toISOString()` with an explicit `::timestamptz` cast to get the
      // same guarantee across its two drivers.
      await seedAtInstants("tt-tz");

      await prisma.$transaction(async (itx) => {
        await itx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
        // Sanity check that the SET actually took on this connection,
        // otherwise the rest of the test proves nothing.
        const zone = await itx.$queryRawUnsafe<Array<{ tz: string }>>(
          `SELECT current_setting('TIMEZONE') AS tz`,
        );
        expect(first(zone).tz).toBe("Asia/Tokyo");

        const adapter = createPrismaAdapter(itx);
        const justAfter = await adapter.readStateAt(
          itx,
          MACHINE,
          "tt-tz",
          new Date("2026-03-01T12:01:00Z"),
        );
        expect(justAfter?.toState).toBe("authorized");

        const justBefore = await adapter.readStateAt(
          itx,
          MACHINE,
          "tt-tz",
          new Date("2026-03-01T11:59:00Z"),
        );
        expect(justBefore?.toState).toBe("pending");
      });
    });

    it("includes a row whose created_at equals the cutoff exactly", async () => {
      // The predicate is `created_at <= $3`. An inclusive boundary is the
      // documented behaviour, and a driver that rounded the parameter to the
      // second (or dropped sub-second precision) would break it silently.
      const adapter = createPrismaAdapter(prisma);
      await seedAtInstants("tt-3");

      const exact = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-3",
        new Date("2026-03-01T12:00:00.000Z"),
      );
      expect(exact?.toState).toBe("authorized");
    });

    it("keeps millisecond precision in the cutoff", async () => {
      // Postgres stores timestamptz to microseconds and a JS Date carries
      // milliseconds. If the binding truncated to whole seconds, the .400
      // cutoff below would sweep in the .500 row.
      const adapter = createPrismaAdapter(prisma);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${DEFAULT_TABLE}"
           (machine, subject_id, to_state, sort_key, most_recent, created_at)
         VALUES
           ($1, 'tt-ms', 'first',  1, FALSE, '2026-03-01T12:00:00.100Z'),
           ($1, 'tt-ms', 'second', 2, TRUE,  '2026-03-01T12:00:00.500Z')`,
        MACHINE,
      );

      const at = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-ms",
        new Date("2026-03-01T12:00:00.400Z"),
      );
      expect(at?.toState).toBe("first");
    });

    it("works with a Date taken from the clock between two appends", async () => {
      // The user-facing shape of time travel: write, note the time, write
      // again, ask what the state was. Uses the adapter end to end so the
      // cutoff is compared against created_at values Postgres itself assigned.
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(
          tx,
          buildRow({ subjectId: "tt-clock", toState: "pending", sortKey: 1 }),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cutoff = new Date();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(
          tx,
          buildRow({
            subjectId: "tt-clock",
            fromState: "pending",
            toState: "authorized",
            sortKey: 2,
          }),
        );
      });

      const at = await adapter.readStateAt(null, MACHINE, "tt-clock", cutoff);
      expect(at?.toState).toBe("pending");
    });

    it("honours a custom tableName on the time-travel read", async () => {
      // `readStateAt` builds its own SQL string, so it is its own chance to
      // have the table name hardcoded.
      const adapter = createPrismaAdapter(prisma, { tableName: CUSTOM_TABLE });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${CUSTOM_TABLE}" (machine, subject_id, to_state, sort_key, most_recent, created_at)
           VALUES ($1, 'tt-custom', 'pending', 1, TRUE, '2026-03-01T11:00:00Z')`,
        MACHINE,
      );
      const at = await adapter.readStateAt(
        null,
        MACHINE,
        "tt-custom",
        new Date("2026-03-01T12:00:00Z"),
      );
      expect(at?.toState).toBe("pending");
    });
  });

  // ── updateSubjectState ────────────────────────────────────

  describe("updateSubjectState", () => {
    function hint(where: Record<string, unknown>): Record<string, unknown> {
      return { model: SUBJECTS_TABLE, column: "state", where };
    }

    async function stateOf(id: string, tenant: string): Promise<string | null> {
      const rows = await raw<{ state: string }>(
        `SELECT state FROM "${SUBJECTS_TABLE}" WHERE id = $1 AND tenant = $2`,
        id,
        tenant,
      );
      return rows[0]?.state ?? null;
    }

    it("writes the new state to the identified row only", async () => {
      // Two subjects share the id 'pay_1' across tenants, so a WHERE that
      // dropped a column (or mis-numbered $2..$N) would update both.
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await updateSubjectState(adapter, 
          tx,
          hint({ id: "pay_1", tenant: "acme" }),
          "authorized",
        );
      });

      expect(await stateOf("pay_1", "acme")).toBe("authorized");
      expect(await stateOf("pay_1", "globex")).toBe("pending");
    });

    it("defaults the target column to `state`", async () => {
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await updateSubjectState(adapter, 
          tx,
          { model: SUBJECTS_TABLE, where: { id: "pay_1", tenant: "acme" } },
          "captured",
        );
      });
      expect(await stateOf("pay_1", "acme")).toBe("captured");
    });

    it("keeps WHERE values bound parameters, so SQL in a value is data", async () => {
      // The identifier allowlist covers model/column/where *keys*, which are
      // the parts that get interpolated. The where *values* are caller data
      // (a subject id straight off a request, in practice) and must travel as
      // bound parameters. A value containing `'; DROP TABLE` is stored and
      // matched literally; if it were ever concatenated into the SQL, the
      // subjects table would be gone by the end of this test.
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await updateSubjectState(adapter, 
          tx,
          hint({ id: INJECTION_ID, tenant: "acme" }),
          "authorized",
        );
      });

      // The table survives, with all three seeded rows.
      expect(await countRows(SUBJECTS_TABLE)).toBe(3);
      // The row whose id *is* that string was the one updated.
      expect(await stateOf(INJECTION_ID, "acme")).toBe("authorized");
      // And the literal text is still in the column, unexecuted and unmangled.
      const stored = await raw<{ id: string }>(
        `SELECT id FROM "${SUBJECTS_TABLE}" WHERE state = 'authorized'`,
      );
      expect(first(stored).id).toBe(INJECTION_ID);
    });

    it("keeps the new state value a bound parameter too", async () => {
      // Same argument for `newState`, which is $1.
      const nasty = `done'; DROP TABLE "${SUBJECTS_TABLE}"; --`;
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await updateSubjectState(adapter, tx, hint({ id: "pay_1", tenant: "acme" }), nasty);
      });
      expect(await stateOf("pay_1", "acme")).toBe(nasty);
      expect(await countRows(SUBJECTS_TABLE)).toBe(3);
    });

    it("is a no-op when the WHERE matches nothing", async () => {
      // Core calls this as a denormalization side-effect. A missing row is
      // not an error | it must not blow up the transition.
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await updateSubjectState(adapter, 
          tx,
          hint({ id: "no-such-subject", tenant: "acme" }),
          "authorized",
        );
      });
      expect(await countRows(SUBJECTS_TABLE, "state <> 'pending'")).toBe(0);
    });

    it("rejects a malformed hint with AdapterError", async () => {
      // Every one of these would otherwise reach raw SQL as an identifier.
      const adapter = createPrismaAdapter(prisma);
      await adapter.withTransaction(async (tx) => {
        await expect(
          updateSubjectState(adapter, tx, { where: { id: "pay_1" } }, "x"),
        ).rejects.toThrow(AdapterError);
        await expect(
          updateSubjectState(adapter, tx, { model: SUBJECTS_TABLE }, "x"),
        ).rejects.toThrow(AdapterError);
        await expect(
          updateSubjectState(adapter, tx, { model: SUBJECTS_TABLE, where: {} }, "x"),
        ).rejects.toThrow(AdapterError);
        await expect(
          updateSubjectState(adapter, 
            tx,
            { model: `${SUBJECTS_TABLE}"; DROP TABLE x; --`, where: { id: "pay_1" } },
            "x",
          ),
        ).rejects.toThrow(AdapterError);
        await expect(
          updateSubjectState(adapter, 
            tx,
            { model: SUBJECTS_TABLE, column: "state; DROP TABLE x", where: { id: "pay_1" } },
            "x",
          ),
        ).rejects.toThrow(AdapterError);
        await expect(
          updateSubjectState(adapter, 
            tx,
            { model: SUBJECTS_TABLE, where: { "id\"; DROP TABLE x; --": "pay_1" } },
            "x",
          ),
        ).rejects.toThrow(AdapterError);
      });

      expect(await countRows(SUBJECTS_TABLE)).toBe(3);
    });
  });

  // ── Rollback leaves nothing behind ────────────────────────

  it("rolls back the transition row and the denormalized state together", async () => {
    // The transition and the subject's state column are written in one
    // transaction precisely so they cannot disagree. This is the test that
    // the denormalized write is inside that transaction and not on a
    // separate connection, which is the failure mode that leaves a subject
    // marked `authorized` with no transition explaining it.
    const adapter = createPrismaAdapter(prisma);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "pay_1");
        await adapter.appendTransition(
          tx,
          buildRow({ subjectId: "pay_1", toState: "authorized", sortKey: 1 }),
        );
        await updateSubjectState(adapter, 
          tx,
          { model: SUBJECTS_TABLE, where: { id: "pay_1", tenant: "acme" } },
          "authorized",
        );
        throw new Error("simulated business-logic failure");
      }),
    ).rejects.toThrow("simulated business-logic failure");

    expect(await countRows(DEFAULT_TABLE)).toBe(0);
    expect(await countRows(SUBJECTS_TABLE, "state <> 'pending'")).toBe(0);
  });

  it("rolls back a multi-append transaction completely", async () => {
    const adapter = createPrismaAdapter(prisma);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "multi");
        await adapter.appendTransition(
          tx,
          buildRow({ subjectId: "multi", toState: "pending", sortKey: 1 }),
        );
        await adapter.appendTransition(
          tx,
          buildRow({ subjectId: "multi", fromState: "pending", toState: "authorized", sortKey: 2 }),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await countRows(DEFAULT_TABLE)).toBe(0);
    // And the advisory lock went with it, so the next writer is not wedged.
    const adapterAfter: Adapter<PrismaRawCalls> = createPrismaAdapter(prisma);
    await adapterAfter.withTransaction(async (tx) => {
      await adapterAfter.acquireLock(tx, MACHINE, "multi");
      await adapterAfter.appendTransition(
        tx,
        buildRow({ subjectId: "multi", toState: "pending", sortKey: 1 }),
      );
    });
    expect(await countRows(DEFAULT_TABLE)).toBe(1);
  });
});
