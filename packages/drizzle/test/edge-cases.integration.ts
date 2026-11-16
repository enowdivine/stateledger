/**
 * Edge-case integration suite for the Drizzle adapter, run twice: once
 * through `drizzle-orm/node-postgres` and once through
 * `drizzle-orm/postgres-js`, against one shared Postgres.
 *
 * The shared `runContractTests` pack proves the happy path through a root
 * client in pessimistic mode. Everything here is what that pack cannot see:
 * a transaction the caller opened, optimistic locking, a non-default table
 * name, what the metadata column actually holds at rest, the `Date` cutoff
 * on `readStateAt`, and the `where` values of `updateSubjectState`.
 *
 * Running it under both flavours is the whole point. Every parameter this
 * adapter binds is a place where the two drivers can disagree, and this
 * package has already been burned there once: `readStateAt` bound a raw
 * `Date`, which node-postgres serializes itself and postgres.js rejects with
 * `TypeError: The "string" argument must be of type string ... Received an
 * instance of Date`. Time travel was broken on postgres.js from v0.2.0 until
 * today, and the 12-test contract suite never saw it because it only ever ran
 * the node-postgres flavour. The sibling `@stateledger/pg` adapter was bitten
 * by the same class from the other direction: a pre-stringified JSON string
 * bound to a `::jsonb` parameter, which postgres.js serialized a second time,
 * so what landed in the column was a jsonb *scalar string* holding JSON text
 * instead of a jsonb object.
 *
 * Two habits follow from that, and both are deliberate here:
 *   - assertions about stored data go through raw SQL (`jsonb_typeof`,
 *     `metadata::text`), never through the adapter that wrote the row, because
 *     a symmetric encoding bug is invisible to a round-trip;
 *   - time-travel rows are pinned to known instants with explicit SQL, so an
 *     offset shows up as a wrong row rather than hiding inside "now".
 *
 * Run locally:
 *   pnpm --filter @stateledger/drizzle test:integration
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import type { Adapter, NewTransitionRow } from "@stateledger/core";
import { sql, type SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Pool } from "pg";
import postgres from "postgres";

import { createDrizzleAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";
import type { DrizzleAdapterOptions, DrizzleExecutor } from "../src/types.js";

const MACHINE = "edge-machine";
const DEFAULT_TABLE = "stateledger_transitions";
const CUSTOM_TABLE = "tenant_acme_transitions";
const SUBJECTS_TABLE = "edge_subjects";

/** A subject id that would drop a table if it were ever interpolated. */
const INJECTION_ID = `x'; DROP TABLE "${SUBJECTS_TABLE}"; --`;

let container: StartedTestContainer;
let pool: Pool;
let nodePgDb: NodePgDatabase;
let pgJsClient: ReturnType<typeof postgres>;
let postgresJsDb: PostgresJsDatabase;

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

  const connectionString =
    `postgresql://stateledger:stateledger@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/stateledger_test`;

  // One database, two drivers. Both suites below talk to the same tables,
  // which is safe because vitest runs the files' suites sequentially and every
  // test truncates first | and it is useful, because it means neither flavour
  // gets a schema the other has not seen.
  pool = new Pool({ connectionString });
  nodePgDb = drizzleNodePg(pool);
  pgJsClient = postgres(connectionString);
  postgresJsDb = drizzlePostgresJs(pgJsClient);

  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await nodePgDb.execute(sql.raw(stmt));
  }
  // The same schema under a second table name, for the custom-tableName test.
  // Index names are rewritten with it so the two schemas can coexist.
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) {
    await nodePgDb.execute(sql.raw(stmt.replaceAll(DEFAULT_TABLE, CUSTOM_TABLE)));
  }
  // Stand-in for a user's own domain table, the target of updateSubjectState.
  // Two identifying columns, because the adapter builds a multi-column WHERE
  // and that is its own opportunity for a mis-join.
  await nodePgDb.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${SUBJECTS_TABLE}" (
         id      TEXT NOT NULL,
         tenant  TEXT NOT NULL,
         state   TEXT NOT NULL,
         PRIMARY KEY (id, tenant)
       )`,
    ),
  );
}, 120_000);

afterAll(async () => {
  await pool?.end();
  // postgres.js closes its own connections; there is no pool to end.
  await pgJsClient?.end();
  await container?.stop();
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
 * Unwrap `execute()` across the two flavours, the same way the adapter does
 * internally: node-postgres resolves to pg's `{ rows }` and postgres.js
 * resolves to an array. Deliberately duplicated rather than imported, so a
 * change to the adapter's own unwrapping cannot silently change what these
 * tests observe.
 */
function extract<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error("unexpected execute() result shape in test helper");
}

/** Index access with a real failure message, since `noUncheckedIndexedAccess` is on. */
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row, got none");
  return row;
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
  adapter: Adapter<DrizzleExecutor>,
  tx: DrizzleExecutor,
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

/** Raw SQL runner, bypassing the adapter entirely. */
type RawRunner = <T>(query: SQL) => Promise<T[]>;

/** What a caller-owned transaction hands to the test body. */
type CallerTx = {
  /** The transaction context, as a user would pass it to `createDrizzleAdapter`. */
  tx: DrizzleExecutor;
  /** Raw SQL on that same transaction's connection. */
  raw: RawRunner;
};

type Flavor = {
  label: string;
  create: (options?: DrizzleAdapterOptions) => Adapter<DrizzleExecutor>;
  /** Raw SQL on the root client, i.e. outside any caller transaction. */
  raw: RawRunner;
  /** Open a transaction the way a user's own code would, then run `fn` in it. */
  withCallerTx: <R>(fn: (ctx: CallerTx) => Promise<R>) => Promise<R>;
};

const flavors = (): Flavor[] => [
  {
    label: "node-postgres",
    create: (options) => createDrizzleAdapter(nodePgDb, options),
    raw: async <T>(query: SQL) => extract<T>(await nodePgDb.execute(query)),
    withCallerTx: (fn) =>
      nodePgDb.transaction((tx) =>
        fn({ tx, raw: async <T>(query: SQL) => extract<T>(await tx.execute(query)) }),
      ),
  },
  {
    label: "postgres.js",
    create: (options) => createDrizzleAdapter(postgresJsDb, options),
    raw: async <T>(query: SQL) => extract<T>(await postgresJsDb.execute(query)),
    withCallerTx: (fn) =>
      postgresJsDb.transaction((tx) =>
        fn({ tx, raw: async <T>(query: SQL) => extract<T>(await tx.execute(query)) }),
      ),
  },
];

function runEdgeCases(flavor: Flavor): void {
  describe(`DrizzleAdapter edge cases (real Postgres, ${flavor.label})`, () => {
    const raw = flavor.raw;

    async function countRows(table: string, where: SQL = sql`TRUE`): Promise<number> {
      // COUNT(*) is bigint, which both drivers hand back as a string; cast to
      // int in SQL and keep the assertion a plain number comparison.
      const rows = await raw<{ n: number }>(
        sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(table)} WHERE ${where}`,
      );
      return first(rows).n;
    }

    async function advisoryLockCount(): Promise<number> {
      const rows = await raw<{ n: number }>(
        sql`SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      return first(rows).n;
    }

    beforeEach(async () => {
      await raw(sql`TRUNCATE ${sql.identifier(DEFAULT_TABLE)}`);
      await raw(sql`TRUNCATE ${sql.identifier(CUSTOM_TABLE)}`);
      await raw(sql`TRUNCATE ${sql.identifier(SUBJECTS_TABLE)}`);
      // Three subjects: two legitimate rows sharing an id across tenants (so a
      // WHERE that dropped a column would be caught), plus the injection probe.
      await raw(
        sql`INSERT INTO ${sql.identifier(SUBJECTS_TABLE)} (id, tenant, state) VALUES
              ('pay_1', 'acme', 'pending'),
              ('pay_1', 'globex', 'pending'),
              (${INJECTION_ID}, 'acme', 'pending')`,
      );
    });

    // ── Joining a transaction the caller already opened ────────

    it("joins a caller-supplied transaction instead of opening its own", async () => {
      // `createDrizzleAdapter` accepts a Drizzle transaction context so a
      // transition can be one step inside a larger business transaction. The
      // failure mode this guards is the adapter quietly writing on a *second*
      // connection: the row would survive the caller's rollback, and the
      // audit trail would record a transition that never happened.
      //
      // Unlike Prisma's interactive-transaction client, a Drizzle tx still
      // exposes `transaction()`, so the adapter's `withTransaction` opens a
      // SAVEPOINT inside the caller's transaction rather than running flat.
      // That is still joining | the savepoint dies with the outer rollback,
      // which is what the assertion after this block checks.
      const trap = new Error("caller rolled back");

      await expect(
        flavor.withCallerTx(async ({ tx }) => {
          const joined = createDrizzleAdapter(tx);
          await joined.withTransaction(async (inner) => {
            await joined.acquireLock(inner, MACHINE, "joined");
            await joined.appendTransition(
              inner,
              buildRow({ subjectId: "joined", toState: "pending" }),
            );
            const inside = await joined.readCurrent(inner, MACHINE, "joined");
            expect(inside?.toState).toBe("pending");
          });

          // Visible inside the caller's transaction, invisible outside it.
          // `flavor.raw` runs on the root client, i.e. another connection.
          expect(await countRows(DEFAULT_TABLE, sql`subject_id = 'joined'`)).toBe(0);

          throw trap;
        }),
      ).rejects.toThrow("caller rolled back");

      expect(await countRows(DEFAULT_TABLE, sql`subject_id = 'joined'`)).toBe(0);
    });

    it("lets a caller-supplied transaction commit the transition it joined", async () => {
      // The mirror of the rollback case. Without it, an adapter that dropped
      // the write entirely would still pass the test above.
      await flavor.withCallerTx(async ({ tx }) => {
        const joined = createDrizzleAdapter(tx);
        await joined.withTransaction(async (inner) => {
          await joined.acquireLock(inner, MACHINE, "joined-commit");
          await joined.appendTransition(
            inner,
            buildRow({ subjectId: "joined-commit", toState: "pending" }),
          );
        });
      });

      const history = await flavor
        .create()
        .readHistory(null, MACHINE, "joined-commit");
      expect(history.map((r) => r.toState)).toEqual(["pending"]);
    });

    it("reads a caller transaction's uncommitted writes when handed its tx", async () => {
      // The read paths take `tx | null`. Passing `null` reads outside any
      // transaction, which for a caller mid-transaction means reading stale
      // data; passing the tx has to read through it.
      await expect(
        flavor.withCallerTx(async ({ tx }) => {
          const joined = createDrizzleAdapter(tx);
          await joined.withTransaction(async (inner) => {
            await joined.acquireLock(inner, MACHINE, "joined-read");
            await joined.appendTransition(
              inner,
              buildRow({ subjectId: "joined-read", toState: "pending" }),
            );

            expect(await joined.readHistory(inner, MACHINE, "joined-read")).toHaveLength(1);
            const at = await joined.readStateAt(inner, MACHINE, "joined-read", new Date());
            expect(at?.toState).toBe("pending");
          });
          throw new Error("discard");
        }),
      ).rejects.toThrow("discard");

      expect(await countRows(DEFAULT_TABLE, sql`subject_id = 'joined-read'`)).toBe(0);
    });

    // ── locking: "optimistic" ─────────────────────────────────

    it("optimistic locking surfaces exactly one winner and an OptimisticConcurrencyError for the loser", async () => {
      // Optimistic mode makes `acquireLock` a no-op and leans entirely on the
      // partial unique index to catch a lost race. What is actually under test
      // is the error *class*: callers retry on OptimisticConcurrencyError, so
      // if `isUniqueViolation` fails to recognize how this driver reports
      // SQLSTATE 23505 the loser degrades to a generic AdapterError, retry
      // loops stop firing, and the failure reads as a random 500 under load.
      // The two drivers nest that code differently (`.code` directly, or
      // under `.cause` / `.original` once a wrapper is involved), which is
      // precisely why this runs under both.
      const adapter = flavor.create({ locking: "optimistic" });
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
      expect(await countRows(DEFAULT_TABLE, sql`subject_id = ${subjectId}`)).toBe(2);
      expect(
        await countRows(
          DEFAULT_TABLE,
          sql`subject_id = ${subjectId} AND most_recent = TRUE`,
        ),
      ).toBe(1);
    });

    it("takes an advisory lock in pessimistic mode and none in optimistic mode", async () => {
      // If `acquireLock` still took `pg_advisory_xact_lock` in optimistic
      // mode, optimistic mode would quietly behave like pessimistic mode and
      // the race above would never actually race | it would pass for the
      // wrong reason forever.
      //
      // The count is read on a different connection from the transaction, so
      // it cannot filter by `pg_backend_pid()` and counts every advisory lock
      // in the cluster instead. Sound here because the suite runs sequentially
      // against a private container.
      const optimistic = flavor.create({ locking: "optimistic" });
      await optimistic.withTransaction(async (tx) => {
        await optimistic.acquireLock(tx, MACHINE, "lock-probe");
        expect(await advisoryLockCount()).toBe(0);
      });

      const pessimistic = flavor.create();
      await pessimistic.withTransaction(async (tx) => {
        await pessimistic.acquireLock(tx, MACHINE, "lock-probe");
        expect(await advisoryLockCount()).toBe(1);
      });

      // Advisory *xact* locks release with the transaction, with no explicit
      // unlock call | the reason the adapter uses the xact variant rather than
      // `pg_advisory_lock`, which would leak a lock per transition and
      // eventually wedge the subject for the life of the connection.
      expect(await advisoryLockCount()).toBe(0);
    });

    // ── Custom tableName ──────────────────────────────────────

    it("writes and reads every path through a custom tableName", async () => {
      // `tableName` goes into `sql.identifier()` in nine different statements.
      // One left hardcoded would still pass the contract suite (it runs
      // against the default name) and corrupt a tenant-namespaced deployment.
      const adapter = flavor.create({ tableName: CUSTOM_TABLE });
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
      // `sql.identifier()` quotes, which makes injection hard but not the
      // adapter's problem to assume away: failing at construction time keeps a
      // misconfigured table name from reaching SQL at all.
      expect(() =>
        flavor.create({ tableName: `t"; DROP TABLE "${SUBJECTS_TABLE}"; --` }),
      ).toThrow(AdapterError);
      expect(() => flavor.create({ tableName: "has-a-dash" })).toThrow(AdapterError);

      expect(await countRows(SUBJECTS_TABLE)).toBe(3);
    });

    // ── Metadata fidelity at rest ─────────────────────────────

    describe("metadata fidelity at rest", () => {
      // The regression tests for the `@stateledger/pg` bug. `metadata` is
      // pre-encoded with `JSON.stringify` and bound to a `::jsonb` parameter,
      // which is exactly the shape postgres.js double-encoded there. Drizzle
      // is safe because it binds parameters itself instead of letting
      // postgres.js infer the OID from the server's description | these tests,
      // run under both flavours, are what keeps that true.
      const cases: Array<{ name: string; metadata: Record<string, unknown> }> = [
        { name: "a nested object", metadata: { outer: { inner: { depth: 3 } } } },
        { name: "an array", metadata: { tags: ["a", "b"], mixed: [1, null, { x: true }] } },
        { name: "a unicode value", metadata: { note: "café ☕ 北京 🚀" } },
        { name: "a value with quotes and backslashes", metadata: { note: 'he said "hi" \\ bye' } },
        {
          name: "a key containing an underscore",
          metadata: { with_underscore: "ok", nested_key: { also_under: 1 } },
        },
        { name: "an empty object", metadata: {} },
        { name: "numbers at the edges of JS precision", metadata: { big: 9007199254740991, float: -1.5, zero: 0 } },
      ];

      for (const [index, testCase] of cases.entries()) {
        it(`stores ${testCase.name} as a jsonb object that round-trips`, async () => {
          const adapter = flavor.create();
          const subjectId = `meta-${index}`;

          const inserted = await adapter.withTransaction(async (tx) => {
            await adapter.acquireLock(tx, MACHINE, subjectId);
            return adapter.appendTransition(
              tx,
              buildRow({ subjectId, toState: "pending", metadata: testCase.metadata }),
            );
          });
          expect(inserted.metadata).toEqual(testCase.metadata);

          // What the column actually holds. `jsonb_typeof` is the assertion
          // that catches double-encoding: a doubly-serialized value reports
          // 'string' here, never 'object'.
          const rows = await raw<{ kind: string; text: string }>(
            sql`SELECT jsonb_typeof(metadata) AS kind, metadata::text AS text
                  FROM ${sql.identifier(DEFAULT_TABLE)} WHERE subject_id = ${subjectId}`,
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
        // byte-identical, with `jsonb_typeof` on the member reporting 'string'.
        const metadata = { payload: '{"not":"parsed"}', empty: "" };
        const adapter = flavor.create();

        await adapter.withTransaction(async (tx) => {
          await adapter.appendTransition(
            tx,
            buildRow({ subjectId: "meta-json-string", toState: "pending", metadata }),
          );
        });

        const rows = await raw<{ outer: string; member: string; value: string }>(
          sql`SELECT jsonb_typeof(metadata) AS outer,
                     jsonb_typeof(metadata -> 'payload') AS member,
                     metadata ->> 'payload' AS value
                FROM ${sql.identifier(DEFAULT_TABLE)}
               WHERE subject_id = 'meta-json-string'`,
        );
        const row = first(rows);
        expect(row.outer).toBe("object");
        expect(row.member).toBe("string");
        expect(row.value).toBe('{"not":"parsed"}');

        const history = await adapter.readHistory(null, MACHINE, "meta-json-string");
        expect(first(history).metadata).toEqual(metadata);
      });

      it("defaults null metadata to an empty jsonb object on write", async () => {
        // Core types `metadata` as non-nullable, but JS callers reach the
        // adapter untyped and the adapter explicitly defends with
        // `row.metadata ?? {}`. Casting through `unknown` is the only way to
        // exercise that defence | a null cannot be typed into a
        // non-nullable field.
        const rowWithNullMetadata = {
          ...buildRow({ subjectId: "meta-null", toState: "pending" }),
          metadata: null,
        } as unknown as NewTransitionRow;

        const adapter = flavor.create();
        const inserted = await adapter.withTransaction(async (tx) =>
          adapter.appendTransition(tx, rowWithNullMetadata),
        );
        expect(inserted.metadata).toEqual({});

        const rows = await raw<{ kind: string }>(
          sql`SELECT jsonb_typeof(metadata) AS kind FROM ${sql.identifier(DEFAULT_TABLE)}
                WHERE subject_id = 'meta-null'`,
        );
        expect(first(rows).kind).toBe("object");
      });

      it("maps a SQL NULL in the metadata column to an empty object on read", async () => {
        // The column is NOT NULL in our recommended schema, but adapters get
        // pointed at pre-existing tables where it is nullable, and `mapRow`
        // promises `metadata` is always an object.
        await raw(
          sql`ALTER TABLE ${sql.identifier(DEFAULT_TABLE)} ALTER COLUMN metadata DROP NOT NULL`,
        );
        try {
          await raw(
            sql`INSERT INTO ${sql.identifier(DEFAULT_TABLE)}
                  (machine, subject_id, to_state, sort_key, metadata)
                VALUES (${MACHINE}, 'meta-sql-null', 'pending', 1, NULL)`,
          );
          const history = await flavor.create().readHistory(null, MACHINE, "meta-sql-null");
          expect(first(history).metadata).toEqual({});
        } finally {
          await raw(
            sql`DELETE FROM ${sql.identifier(DEFAULT_TABLE)} WHERE subject_id = 'meta-sql-null'`,
          );
          await raw(
            sql`ALTER TABLE ${sql.identifier(DEFAULT_TABLE)} ALTER COLUMN metadata SET NOT NULL`,
          );
        }
      });
    });

    // ── readStateAt with a real Date cutoff ───────────────────

    describe("readStateAt with a real Date cutoff", () => {
      // The direct regression tests for this package's own shipped bug: a raw
      // `Date` bound to the cutoff parameter, which node-postgres serialized
      // and postgres.js refused with `The "string" argument must be of type
      // string ... Received an instance of Date`. Every test in this block
      // calls `readStateAt` with a real `Date`, and the whole block runs under
      // both flavours, which is the combination that was missing.

      /** Pin rows to known instants, bypassing the column's NOW() default. */
      async function seedAtInstants(subjectId: string): Promise<void> {
        await raw(
          sql`INSERT INTO ${sql.identifier(DEFAULT_TABLE)}
                (machine, subject_id, from_state, to_state, sort_key, most_recent, created_at)
              VALUES
                (${MACHINE}, ${subjectId}, NULL, 'pending', 1, FALSE, ${"2026-03-01T11:00:00Z"}::timestamptz),
                (${MACHINE}, ${subjectId}, 'pending', 'authorized', 2, FALSE, ${"2026-03-01T12:00:00Z"}::timestamptz),
                (${MACHINE}, ${subjectId}, 'authorized', 'captured', 3, TRUE, ${"2026-03-01T13:00:00Z"}::timestamptz)`,
        );
      }

      it("resolves a cutoff between two known instants", async () => {
        const adapter = flavor.create();
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
        // whole-hour shift flips an assertion. The third is the same instant
        // as the first written with a +09:00 offset instead of Z, which proves
        // the offset is honoured rather than parsed away.
        const adapter = flavor.create();
        await seedAtInstants("tt-2");

        expect(
          (await adapter.readStateAt(null, MACHINE, "tt-2", new Date("2026-03-01T12:01:00Z")))
            ?.toState,
        ).toBe("authorized");
        expect(
          (await adapter.readStateAt(null, MACHINE, "tt-2", new Date("2026-03-01T11:59:00Z")))
            ?.toState,
        ).toBe("pending");
        // 21:01 in Tokyo is 12:01 UTC: same instant, different wall clock.
        expect(
          (
            await adapter.readStateAt(
              null,
              MACHINE,
              "tt-2",
              new Date("2026-03-01T21:01:00+09:00"),
            )
          )?.toState,
        ).toBe("authorized");
      });

      it("treats the cutoff as an instant on a connection whose session timezone is not UTC", async () => {
        // This is the real guard against a cutoff that loses its timezone, and
        // it needs its own session to work: the test container runs in UTC, so
        // a naive timestamp would still compare correctly there and the suite
        // would be blind to it. `SET LOCAL TIME ZONE` pins the session for
        // exactly the connection the adapter then reads on, and under
        // Asia/Tokyo a cutoff Postgres has to read as wall-clock lands nine
        // hours out | far enough to flip both assertions, which sit one minute
        // either side of a stored instant.
        //
        // The adapter binds `at.toISOString()` with an explicit `::timestamptz`
        // cast for this reason: both drivers send the same bytes and Postgres
        // does the conversion from an unambiguous UTC string.
        await seedAtInstants("tt-tz");

        await flavor.withCallerTx(async ({ tx, raw: rawInTx }) => {
          await rawInTx(sql`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
          // Sanity check that the SET took on this connection, otherwise the
          // rest of the test proves nothing.
          const zone = await rawInTx<{ tz: string }>(
            sql`SELECT current_setting('TIMEZONE') AS tz`,
          );
          expect(first(zone).tz).toBe("Asia/Tokyo");

          const adapter = createDrizzleAdapter(tx);
          expect(
            (await adapter.readStateAt(tx, MACHINE, "tt-tz", new Date("2026-03-01T12:01:00Z")))
              ?.toState,
          ).toBe("authorized");
          expect(
            (await adapter.readStateAt(tx, MACHINE, "tt-tz", new Date("2026-03-01T11:59:00Z")))
              ?.toState,
          ).toBe("pending");
        });
      });

      it("includes a row whose created_at equals the cutoff exactly", async () => {
        // The predicate is `created_at <= $cutoff`. The inclusive boundary is
        // documented behaviour, and a binding that rounded the parameter would
        // break it silently.
        const adapter = flavor.create();
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
        const adapter = flavor.create();
        await raw(
          sql`INSERT INTO ${sql.identifier(DEFAULT_TABLE)}
                (machine, subject_id, to_state, sort_key, most_recent, created_at)
              VALUES
                (${MACHINE}, 'tt-ms', 'first', 1, FALSE, ${"2026-03-01T12:00:00.100Z"}::timestamptz),
                (${MACHINE}, 'tt-ms', 'second', 2, TRUE, ${"2026-03-01T12:00:00.500Z"}::timestamptz)`,
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
        // again, ask what the state was. End to end through the adapter, so
        // the cutoff is compared against created_at values Postgres assigned.
        const adapter = flavor.create();
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
        // `readStateAt` builds its own statement, so it is its own chance to
        // have the table name hardcoded.
        const adapter = flavor.create({ tableName: CUSTOM_TABLE });
        await raw(
          sql`INSERT INTO ${sql.identifier(CUSTOM_TABLE)}
                (machine, subject_id, to_state, sort_key, most_recent, created_at)
              VALUES (${MACHINE}, 'tt-custom', 'pending', 1, TRUE, ${"2026-03-01T11:00:00Z"}::timestamptz)`,
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
          sql`SELECT state FROM ${sql.identifier(SUBJECTS_TABLE)}
                WHERE id = ${id} AND tenant = ${tenant}`,
        );
        return rows[0]?.state ?? null;
      }

      it("writes the new state to the identified row only", async () => {
        // Two subjects share the id 'pay_1' across tenants, so a WHERE that
        // dropped a column would update both.
        const adapter = flavor.create();
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
        const adapter = flavor.create();
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
        // what gets interpolated. The where *values* are caller data (a subject
        // id straight off a request, in practice) and must travel as bound
        // parameters. If this value were ever concatenated into the SQL, the
        // subjects table would be gone by the end of this test.
        const adapter = flavor.create();
        await adapter.withTransaction(async (tx) => {
          await updateSubjectState(adapter, 
            tx,
            hint({ id: INJECTION_ID, tenant: "acme" }),
            "authorized",
          );
        });

        expect(await countRows(SUBJECTS_TABLE)).toBe(3);
        expect(await stateOf(INJECTION_ID, "acme")).toBe("authorized");
        // The literal text is still in the column, unexecuted and unmangled.
        const stored = await raw<{ id: string }>(
          sql`SELECT id FROM ${sql.identifier(SUBJECTS_TABLE)} WHERE state = 'authorized'`,
        );
        expect(first(stored).id).toBe(INJECTION_ID);
      });

      it("keeps the new state value a bound parameter too", async () => {
        const nasty = `done'; DROP TABLE "${SUBJECTS_TABLE}"; --`;
        const adapter = flavor.create();
        await adapter.withTransaction(async (tx) => {
          await updateSubjectState(adapter, tx, hint({ id: "pay_1", tenant: "acme" }), nasty);
        });
        expect(await stateOf("pay_1", "acme")).toBe(nasty);
        expect(await countRows(SUBJECTS_TABLE)).toBe(3);
      });

      it("is a no-op when the WHERE matches nothing", async () => {
        // Core calls this as a denormalization side-effect. A missing row is
        // not an error | it must not blow up the transition.
        const adapter = flavor.create();
        await adapter.withTransaction(async (tx) => {
          await updateSubjectState(adapter, 
            tx,
            hint({ id: "no-such-subject", tenant: "acme" }),
            "authorized",
          );
        });
        expect(await countRows(SUBJECTS_TABLE, sql`state <> 'pending'`)).toBe(0);
      });

      it("rejects a malformed hint with AdapterError", async () => {
        // Each of these would otherwise reach raw SQL as an identifier.
        const adapter = flavor.create();
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
              { model: SUBJECTS_TABLE, where: { 'id"; DROP TABLE x; --': "pay_1" } },
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
      // separate connection | the failure mode that leaves a subject marked
      // `authorized` with no transition explaining it.
      const adapter = flavor.create();

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
      expect(await countRows(SUBJECTS_TABLE, sql`state <> 'pending'`)).toBe(0);
    });

    it("rolls back a multi-append transaction completely", async () => {
      const adapter = flavor.create();

      await expect(
        adapter.withTransaction(async (tx) => {
          await adapter.acquireLock(tx, MACHINE, "multi");
          await adapter.appendTransition(
            tx,
            buildRow({ subjectId: "multi", toState: "pending", sortKey: 1 }),
          );
          await adapter.appendTransition(
            tx,
            buildRow({
              subjectId: "multi",
              fromState: "pending",
              toState: "authorized",
              sortKey: 2,
            }),
          );
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await countRows(DEFAULT_TABLE)).toBe(0);

      // And the advisory lock went with it, so the next writer is not wedged.
      const after = flavor.create();
      await after.withTransaction(async (tx) => {
        await after.acquireLock(tx, MACHINE, "multi");
        await after.appendTransition(
          tx,
          buildRow({ subjectId: "multi", toState: "pending", sortKey: 1 }),
        );
      });
      expect(await countRows(DEFAULT_TABLE)).toBe(1);
    });
  });
}

for (const flavor of flavors()) {
  runEdgeCases(flavor);
}
