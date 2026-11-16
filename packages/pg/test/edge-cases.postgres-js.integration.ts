/**
 * Edge cases for `@stateledger/pg` on postgres.js.
 *
 * Split from `edge-cases.integration.ts` because postgres.js diverges from
 * node-postgres on exactly the things this file tests: how a caller's
 * transaction is joined (savepoint, not a borrowed connection), how values
 * are serialized (by the OID the server describes, which is what caused
 * the jsonb double-encode), and what a `transform` option does to result
 * keys.
 *
 * Every test says what real failure it guards against.
 *
 * Run locally:
 *   pnpm --filter @stateledger/pg test:integration
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import postgres from "postgres";

import { createPostgresJsAdapter, STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";
import type { PostgresJsQueryable, PostgresJsSql } from "../src/index.js";
import {
  buildRow,
  CUSTOM_TABLE,
  DEFAULT_TABLE,
  MACHINE,
  requireUpdateSubjectState,
  RICH_METADATA,
  schemaFor,
  SIDE_TABLE_DDL,
  startPostgres,
} from "./edge-case-helpers.js";

/** Values the test helpers bind. Mirrors what postgres.js will accept. */
type Bindable = string | number | boolean | Date | null;

let container: StartedTestContainer;
let connectionString: string;
let sql: postgres.Sql;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  connectionString = started.connectionString;

  sql = postgres(connectionString);
  for (const stmt of STATELEDGER_SCHEMA_STATEMENTS) await sql.unsafe(stmt);
  for (const stmt of schemaFor(CUSTOM_TABLE)) await sql.unsafe(stmt);
  await sql.unsafe(SIDE_TABLE_DDL);
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

beforeEach(async () => {
  await sql.unsafe(`TRUNCATE "${DEFAULT_TABLE}", "${CUSTOM_TABLE}", "payments"`);
});

/** Run a raw query on the root connection, outside the adapter. */
async function q<T = Record<string, unknown>>(text: string, values: Bindable[] = []): Promise<T[]> {
  const rows = await sql.unsafe(text, values as never[]);
  return rows as unknown as T[];
}

async function countRows(table: string): Promise<number> {
  const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
  return rows[0]?.n ?? 0;
}

/**
 * postgres.js's `TransactionSql` carries the surface the adapter needs
 * (`unsafe` plus a `begin` that opens a savepoint), but its `begin` is
 * overloaded in a way that does not structurally match the single
 * signature `PostgresJsSql` declares. Narrowing here keeps the cast in one
 * place instead of at every call site.
 */
function asAdapterSql(tx: postgres.TransactionSql): PostgresJsSql {
  return tx as unknown as PostgresJsSql;
}

// ─────────────────────────────────────────────────────────────
// Joining the caller's transaction (savepoint semantics)
// ─────────────────────────────────────────────────────────────

describe("joining a postgres.js transaction the caller opened", () => {
  it("writes inside the caller's transaction and disappears when it rolls back", async () => {
    // Half the public API, untouched by the shared contract pack. Guards
    // against the adapter calling `begin()` on the root `sql` (which
    // reserves a *different* connection from the pool) when it was handed
    // a transaction handle | the transition would then commit on its own,
    // breaking the atomicity the README promises.
    const rollback = new Error("caller rolled back");
    await expect(
      sql.begin(async (tx) => {
        const adapter = createPostgresJsAdapter(asAdapterSql(tx));
        await adapter.withTransaction(async (atx) => {
          await adapter.acquireLock(atx, MACHINE, "subject-1");
          await adapter.appendTransition(atx, buildRow({ toState: "pending" }));
        });

        // Visible inside the caller's transaction...
        const inside = await tx.unsafe(`SELECT count(*)::int AS n FROM "${DEFAULT_TABLE}"`);
        expect((inside as unknown as { n: number }[])[0]?.n).toBe(1);

        // ...and not from any other connection.
        expect(await countRows(DEFAULT_TABLE)).toBe(0);

        throw rollback;
      }),
    ).rejects.toThrow(rollback);

    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("rolls a failed transition back to its savepoint without aborting the caller", async () => {
    // The documented savepoint claim, and the real reason it matters: a
    // transition that fails must not poison the caller's transaction.
    // Without the savepoint the caller's connection would be left in
    // "current transaction is aborted, commands ignored until end of
    // transaction block" (SQLSTATE 25P02) and every later statement in
    // their unit of work would fail for an unrelated reason.
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "payments" (id, tenant, state) VALUES ('before', 't1', 'created')`,
      );

      const adapter = createPostgresJsAdapter(asAdapterSql(tx));
      await expect(
        adapter.withTransaction(async (atx) => {
          await adapter.appendTransition(atx, buildRow({ toState: "pending" }));
          throw new Error("transition failed");
        }),
      ).rejects.toThrow("transition failed");

      // Caller's transaction is still healthy and can keep writing.
      await tx.unsafe(
        `INSERT INTO "payments" (id, tenant, state) VALUES ('after', 't1', 'created')`,
      );
    });

    // Both of the caller's rows committed...
    const ids = await q<{ id: string }>(`SELECT id FROM "payments" ORDER BY id`);
    expect(ids.map((r) => r.id)).toEqual(["after", "before"]);
    // ...and the transition that failed was rolled back to the savepoint,
    // not carried along by the outer COMMIT.
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("commits a successful transition with the caller's transaction", async () => {
    // The other half of savepoint semantics: a savepoint that succeeded
    // must be released into the enclosing transaction, not rolled back
    // when it ends. Guards against an over-eager `ROLLBACK TO SAVEPOINT`
    // on the success path, which would silently drop every transition
    // written inside a caller-owned transaction.
    await sql.begin(async (tx) => {
      const adapter = createPostgresJsAdapter(asAdapterSql(tx));
      await adapter.withTransaction((atx) =>
        adapter.appendTransition(atx, buildRow({ toState: "pending" })),
      );
      await tx.unsafe(`INSERT INTO "payments" (id, tenant, state) VALUES ('p1', 't1', 'pending')`);
    });

    expect(await countRows(DEFAULT_TABLE)).toBe(1);
    expect(await countRows("payments")).toBe(1);
  });

  it("returns the callback's value through the nested begin", async () => {
    // postgres.js resolves `begin` through its `UnwrapPromiseArray`
    // conditional, which awaits the elements of an array result. The
    // adapter narrows that back to `R`. Guards the narrowing: an array
    // return value must come back as an array, not as a flattened or
    // re-wrapped shape.
    const result = await sql.begin(async (tx) => {
      const adapter = createPostgresJsAdapter(asAdapterSql(tx));
      const scalar = await adapter.withTransaction(async () => 42);
      const list = await adapter.withTransaction(async () => ["a", "b"]);
      return { scalar, list };
    });
    expect(result).toEqual({ scalar: 42, list: ["a", "b"] });
  });
});

// ─────────────────────────────────────────────────────────────
// locking: "optimistic"
// ─────────────────────────────────────────────────────────────

describe('locking: "optimistic" (postgres.js)', () => {
  it("holds no advisory lock, where pessimistic holds exactly one", async () => {
    // Same assertion as the node-postgres suite, repeated here because
    // the advisory-lock statement is the one place the adapter leans on a
    // `::text` cast to disambiguate an overload for postgres.js
    // specifically (it sends strings with an unspecified type OID). A
    // regression there would only show on this driver.
    const advisoryLocks = async (locking: "pessimistic" | "optimistic") => {
      const adapter = createPostgresJsAdapter(sql, { locking });
      return adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        const held = (await tx.unsafe(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
        )) as unknown as { n: number }[];
        return held[0]?.n;
      });
    };

    expect(await advisoryLocks("pessimistic")).toBe(1);
    expect(await advisoryLocks("optimistic")).toBe(0);
  });

  it("produces exactly one winner and an OptimisticConcurrencyError for the loser", async () => {
    // postgres.js surfaces the server error as its own `PostgresError`,
    // not node-postgres's `DatabaseError`. Both carry SQLSTATE on `.code`,
    // and `isUniqueViolation` relies on that. Guards against the loser
    // getting a generic AdapterError on this driver only, which would
    // break every `instanceof OptimisticConcurrencyError` retry loop for
    // postgres.js users while the node-postgres tests stayed green.
    const adapter = createPostgresJsAdapter(sql, { locking: "optimistic" });

    const attempt = (toState: string) =>
      adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "contended");
        return adapter.appendTransition(tx, buildRow({ subjectId: "contended", toState }));
      });

    const results = await Promise.allSettled([attempt("A"), attempt("B")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    const reason = rejected.reason as unknown;
    expect(reason).toBeInstanceOf(OptimisticConcurrencyError);
    expect(reason).not.toBeInstanceOf(AdapterError);
    expect((reason as OptimisticConcurrencyError).subjectId).toBe("contended");

    const rows = await q<{ most_recent: boolean }>(`SELECT most_recent FROM "${DEFAULT_TABLE}"`);
    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r.most_recent)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Custom tableName
// ─────────────────────────────────────────────────────────────

describe("custom tableName (postgres.js)", () => {
  it("drives every read and write against the configured table", async () => {
    // Guards against a hard-coded table name in any one of the five
    // statements the adapter builds. The default table exists too, so a
    // miss would return plausible wrong answers instead of an error.
    const adapter = createPostgresJsAdapter(sql, { tableName: CUSTOM_TABLE });

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
    expect((await adapter.readStateAt(null, MACHINE, "subject-1", new Date()))?.toState).toBe(
      "authorized",
    );

    expect(await countRows(CUSTOM_TABLE)).toBe(2);
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("wraps a missing table in AdapterError rather than leaking a PostgresError", async () => {
    // Guards the error contract on this driver: postgres.js throws its own
    // PostgresError, which must not escape the adapter boundary.
    const adapter = createPostgresJsAdapter(sql, { tableName: "no_such_table" });
    const err = await adapter
      .withTransaction((tx) => adapter.appendTransition(tx, buildRow({ toState: "pending" })))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AdapterError);
    expect(((err as AdapterError).cause as { code?: string }).code).toBe("42P01");
  });
});

// ─────────────────────────────────────────────────────────────
// updateSubjectState
// ─────────────────────────────────────────────────────────────

describe("updateSubjectState (postgres.js)", () => {
  it("writes the denormalized column and keeps where values bound", async () => {
    // Same guarantee as the node-postgres suite, re-asserted here because
    // the values travel through `unsafe()` on this driver, which is the
    // API whose name most invites someone to "simplify" it into string
    // interpolation. If `where` values were interpolated, `payments`
    // would not exist by the end of this test.
    const hostileId = `p9'; DROP TABLE "payments"; --`;
    await q(
      `INSERT INTO "payments" (id, tenant, state, lifecycle_state)
        VALUES ('p1', 't1', 'created', 'created'), ($1, 't1', 'created', 'created')`,
      [hostileId],
    );

    const adapter = createPostgresJsAdapter(sql);
    const update = requireUpdateSubjectState(adapter);

    await adapter.withTransaction(async (tx) => {
      await update(tx, { model: "payments", where: { id: "p1", tenant: "t1" } }, "authorized");
      await update(
        tx,
        { model: "payments", column: "lifecycle_state", where: { id: hostileId, tenant: "t1" } },
        "refunded",
      );
    });

    const rows = await q<{ id: string; state: string | null; lifecycle_state: string | null }>(
      `SELECT id, state, lifecycle_state FROM "payments" ORDER BY id`,
    );
    expect(await countRows("payments")).toBe(2);
    expect(rows.find((r) => r.id === "p1")?.state).toBe("authorized");
    expect(rows.find((r) => r.id === hostileId)?.lifecycle_state).toBe("refunded");
    // The hostile row's own `state` is untouched: the second update named
    // a different column and matched exactly one row.
    expect(rows.find((r) => r.id === hostileId)?.state).toBe("created");
  });

  it("rolls back with the transition when the surrounding savepoint fails", async () => {
    // The audit trail and the denormalized column must never disagree.
    // On this driver the unit of rollback is a savepoint, so this is also
    // a check that the savepoint covers *all* of the adapter's writes,
    // not just the transition insert.
    await q(`INSERT INTO "payments" (id, tenant, state) VALUES ('p1', 't1', 'created')`);
    const adapter = createPostgresJsAdapter(sql);
    const update = requireUpdateSubjectState(adapter);

    await expect(
      adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ toState: "authorized" }));
        await update(tx, { model: "payments", where: { id: "p1", tenant: "t1" } }, "authorized");
        throw new Error("hook failed after both writes");
      }),
    ).rejects.toThrow("hook failed");

    const rows = await q<{ state: string | null }>(`SELECT state FROM "payments"`);
    expect(rows[0]?.state).toBe("created");
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Parameter binding and round-trip fidelity
// ─────────────────────────────────────────────────────────────

describe("parameter binding fidelity (postgres.js)", () => {
  it("stores metadata as a jsonb object, not as a JSON string", async () => {
    // THE regression test for this package's shipped bug. postgres.js
    // asks the server to describe each parameter and serializes with the
    // serializer for the OID it gets back; for `$9::jsonb` that
    // serializer is JSON.stringify, so the adapter's already-encoded
    // string was encoded a second time and the column ended up holding
    // the JSON *string* `"{\"source\":\"test\"}"`. That is a valid jsonb
    // scalar, so nothing failed until a read handed back a string.
    // `jsonb_typeof` catches it at rest, where the corruption is.
    const adapter = createPostgresJsAdapter(sql);
    await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ toState: "pending", metadata: { source: "test" } })),
    );

    const rows = await q<{ t: string; source: string }>(
      `SELECT jsonb_typeof(metadata) AS t, metadata->>'source' AS source FROM "${DEFAULT_TABLE}"`,
    );
    expect(rows[0]?.t).toBe("object");
    expect(rows[0]?.source).toBe("test");
  });

  it("round-trips every JSON shape byte-faithfully", async () => {
    // Nested objects, arrays, unicode, embedded quotes and backslashes, a
    // placeholder-looking string, empty containers, null and numbers, in
    // one payload. Guards any encoding layer on this driver mangling a
    // shape the happy path never sends.
    const adapter = createPostgresJsAdapter(sql);
    const inserted = await adapter.withTransaction((tx) =>
      adapter.appendTransition(tx, buildRow({ toState: "pending", metadata: RICH_METADATA })),
    );
    expect(inserted.metadata).toEqual(RICH_METADATA);
    expect((await adapter.readHistory(null, MACHINE, "subject-1"))[0]?.metadata).toEqual(
      RICH_METADATA,
    );
  });

  it("normalises an empty and an absent metadata to {}", async () => {
    // Guards against a null reaching the NOT NULL column, and against a
    // `null` metadata surfacing to callers typed to receive an object.
    const adapter = createPostgresJsAdapter(sql);
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
    const types = await q<{ t: string }>(
      `SELECT jsonb_typeof(metadata) AS t FROM "${DEFAULT_TABLE}"`,
    );
    expect(types.map((r) => r.t)).toEqual(["object", "object"]);
  });

  it("rejects a NUL byte in metadata as an AdapterError", async () => {
    // jsonb cannot store a NUL byte (SQLSTATE 22P05). Pinned so the
    // failure is a wrapped AdapterError and specifically NOT an
    // OptimisticConcurrencyError | a retry loop would spin forever on
    // input that can never succeed.
    const adapter = createPostgresJsAdapter(sql);
    const err = await adapter
      .withTransaction((tx) =>
        adapter.appendTransition(
          tx,
          buildRow({ toState: "pending", metadata: { note: `a${String.fromCharCode(0)}b` } }),
        ),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AdapterError);
    expect(err).not.toBeInstanceOf(OptimisticConcurrencyError);
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });

  it("binds a real Date for readStateAt, inside and outside a transaction", async () => {
    // The exact failure that took out `@stateledger/drizzle`'s
    // readStateAt on this driver: a raw JS Date bound against a column
    // postgres.js has described, whose serializer then refused it. Only
    // visible on postgres.js, which is why it shipped.
    await q(
      `INSERT INTO "${DEFAULT_TABLE}"
        (machine, subject_id, from_state, to_state, sort_key, most_recent, created_at)
        VALUES ($1, 'subject-1', NULL,        'pending',    1, FALSE, '2026-01-01T00:00:00Z'),
               ($1, 'subject-1', 'pending',   'authorized', 2, FALSE, '2026-02-01T00:00:00Z'),
               ($1, 'subject-1', 'authorized','captured',   3, TRUE,  '2026-03-01T00:00:00Z')`,
      [MACHINE],
    );
    const adapter = createPostgresJsAdapter(sql);

    const at = (iso: string) => adapter.readStateAt(null, MACHINE, "subject-1", new Date(iso));
    expect(await at("2025-12-31T23:59:59Z")).toBeNull();
    expect((await at("2026-01-15T00:00:00Z"))?.toState).toBe("pending");
    expect((await at("2026-02-01T00:00:00Z"))?.toState).toBe("authorized");
    expect((await at("2030-01-01T00:00:00Z"))?.toState).toBe("captured");

    // Same read on a transaction handle | a different code path
    // (`queryOn` rather than `queryOutsideTransaction`), and the one a
    // strict read-after-write caller uses.
    const inTx = await adapter.withTransaction((tx) =>
      adapter.readStateAt(tx, MACHINE, "subject-1", new Date("2026-02-15T00:00:00Z")),
    );
    expect(inTx?.toState).toBe("authorized");
  });

  it("documents the microsecond cutoff that createdAt itself cannot express", async () => {
    // KNOWN WART, pinned deliberately, and identical on both drivers.
    // created_at is TIMESTAMPTZ (microseconds) defaulting to NOW(), but a
    // JS Date only holds milliseconds, so the `createdAt` handed back is
    // truncated and feeding it straight back as a cutoff lands below the
    // row it came from: `stateAt(row.createdAt)` does not see `row`.
    // Fixing it means TIMESTAMPTZ(3) in the DDL that every adapter ships
    // in lockstep, so this test records the behaviour rather than
    // asserting the one we would prefer.
    await q(
      `INSERT INTO "${DEFAULT_TABLE}"
        (machine, subject_id, to_state, sort_key, most_recent, created_at)
        VALUES ($1, 'micros', 'pending', 1, TRUE, '2026-01-01T00:00:00.123456Z')`,
      [MACHINE],
    );
    const adapter = createPostgresJsAdapter(sql);
    const createdAt = (await adapter.readHistory(null, MACHINE, "micros"))[0]?.createdAt;
    if (!createdAt) throw new Error("fixture row was not inserted");

    expect(createdAt.toISOString()).toBe("2026-01-01T00:00:00.123Z");
    expect(await adapter.readStateAt(null, MACHINE, "micros", createdAt)).toBeNull();
    const oneMsLater = new Date(createdAt.getTime() + 1);
    expect((await adapter.readStateAt(null, MACHINE, "micros", oneMsLater))?.toState).toBe(
      "pending",
    );
  });

  it("rejects an undefined field instead of writing NULL (diverges from node-postgres)", async () => {
    // Documented driver divergence, found while writing this suite.
    // `NewTransitionRow` types `fromState` as `string | null`, so a
    // TypeScript caller cannot get here | but a JavaScript caller who
    // omits the field can, and the two drivers then disagree:
    // node-postgres coerces `undefined` to NULL and the insert succeeds,
    // postgres.js refuses the parameter outright. Pinned so the
    // divergence is known rather than discovered in production, and so
    // the failure stays inside AdapterError on this driver.
    const adapter = createPostgresJsAdapter(sql);
    const row = buildRow({ toState: "pending" });
    const err = await adapter
      .withTransaction((tx) =>
        adapter.appendTransition(tx, { ...row, fromState: undefined as unknown as null }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AdapterError);
    expect(await countRows(DEFAULT_TABLE)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// transform options
// ─────────────────────────────────────────────────────────────

describe("postgres.js transform options", () => {
  /** A second connection with a result-key transform applied. */
  async function withTransform<R>(
    transform: postgres.Options<Record<string, never>>["transform"],
    fn: (transformed: postgres.Sql) => Promise<R>,
  ): Promise<R> {
    const transformed = postgres(connectionString, { transform });
    try {
      return await fn(transformed);
    } finally {
      await transformed.end();
    }
  }

  it("supports transform: postgres.camel, metadata keys included", async () => {
    // The README says camel is safe to leave on. It is only safe because
    // every column is aliased to a name with no underscore in it (so the
    // snake-to-camel rewrite is a no-op) and because `metadata` is
    // projected as `::text` (OID 25), which the transform's json/jsonb
    // value rewrite does not touch. The second assertion below is the
    // proof: read the same row as raw jsonb on the same connection and
    // the user's own metadata keys come back mangled.
    await withTransform(postgres.camel, async (transformed) => {
      const adapter = createPostgresJsAdapter(transformed);
      const inserted = await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        return adapter.appendTransition(
          tx,
          buildRow({ toState: "pending", metadata: { payment_intent: "pi_1", a_b: { c_d: 1 } } }),
        );
      });

      expect(inserted.subjectId).toBe("subject-1");
      expect(inserted.metadata).toEqual({ payment_intent: "pi_1", a_b: { c_d: 1 } });

      const current = await adapter.withTransaction((tx) =>
        adapter.readCurrent(tx, MACHINE, "subject-1"),
      );
      expect(current?.toState).toBe("pending");
      expect(current?.metadata).toEqual({ payment_intent: "pi_1", a_b: { c_d: 1 } });
      expect((await adapter.readHistory(null, MACHINE, "subject-1"))[0]?.metadata).toEqual({
        payment_intent: "pi_1",
        a_b: { c_d: 1 },
      });

      // What the adapter is protecting you from: the same value read as
      // jsonb through the same transformed connection.
      const mangled = (await transformed.unsafe(
        `SELECT metadata FROM "${DEFAULT_TABLE}"`,
      )) as unknown as { metadata: Record<string, unknown> }[];
      expect(mangled[0]?.metadata).toEqual({ paymentIntent: "pi_1", aB: { cD: 1 } });
    });
  });

  it("fails loudly under transform: postgres.pascal", async () => {
    // pascal rewrites every result key's first letter, so the adapter's
    // own aliases (`id`, `subjectId`, ...) arrive as `Id`, `SubjectId`.
    // Guards against mapping a row of `undefined`s: without the tripwire
    // in `asRawRow` the caller would get a TransitionRow whose every
    // field is undefined, and the failure would surface somewhere else
    // entirely.
    await withTransform(postgres.pascal, async (transformed) => {
      const adapter = createPostgresJsAdapter(transformed);
      const err = await adapter
        .withTransaction((tx) => adapter.appendTransition(tx, buildRow({ toState: "pending" })))
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).message).toMatch(/transition row is missing the "id" column/);
      expect((err as AdapterError).message).toMatch(/result-key rename/);
    });
  });

  it("survives transform: postgres.kebab, because kebab only rewrites underscores", async () => {
    // Recorded because the source comment and the README both used kebab
    // as the example of a transform that breaks the adapter, and it does
    // not. `postgres.kebab` maps `_` to `-` on the way out, and the
    // adapter's aliases contain no underscores, so every key arrives
    // unchanged. pascal is the one that breaks (see above). The raw-jsonb
    // assertion shows kebab is not harmless in general | it does mangle
    // metadata keys when they are not projected as text.
    await withTransform(postgres.kebab, async (transformed) => {
      const adapter = createPostgresJsAdapter(transformed);
      const inserted = await adapter.withTransaction((tx) =>
        adapter.appendTransition(
          tx,
          buildRow({ toState: "pending", metadata: { payment_intent: "pi_1" } }),
        ),
      );
      expect(inserted.subjectId).toBe("subject-1");
      expect(inserted.metadata).toEqual({ payment_intent: "pi_1" });
      expect((await adapter.readHistory(null, MACHINE, "subject-1"))[0]?.toState).toBe("pending");

      const mangled = (await transformed.unsafe(
        `SELECT metadata FROM "${DEFAULT_TABLE}"`,
      )) as unknown as { metadata: Record<string, unknown> }[];
      expect(mangled[0]?.metadata).toEqual({ "payment-intent": "pi_1" });
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Rollback and connection hygiene
// ─────────────────────────────────────────────────────────────

describe("rollback and connection hygiene (postgres.js)", () => {
  it("leaves nothing behind when the callback throws mid-sequence", async () => {
    // The most_recent flip is a separate statement from the INSERT, so a
    // failure between them could leave a subject with zero current rows.
    const adapter = createPostgresJsAdapter(sql);
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

    const rows = await q<{ to_state: string; most_recent: boolean }>(
      `SELECT to_state, most_recent FROM "${DEFAULT_TABLE}"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.to_state).toBe("pending");
    expect(rows[0]?.most_recent).toBe(true);
  });

  it("does not exhaust the connection pool across many failed transactions", async () => {
    // postgres.js releases the reserved connection in a `finally` inside
    // `begin()`, so there is no `release()` for the adapter to forget |
    // the node-postgres leak this mirrors is structurally impossible
    // here. Asserted anyway with a 2-connection pool: if a rolled-back
    // transaction ever stopped returning its connection, this hangs into
    // a test timeout instead of failing somewhere subtler.
    const small = postgres(connectionString, { max: 2 });
    try {
      const adapter = createPostgresJsAdapter(small);
      for (let i = 0; i < 6; i++) {
        await expect(
          adapter.withTransaction(async (tx) => {
            await adapter.appendTransition(tx, buildRow({ toState: `s${i}` }));
            throw new Error(`fail ${i}`);
          }),
        ).rejects.toThrow(`fail ${i}`);
      }
      await adapter.withTransaction((tx) =>
        adapter.appendTransition(tx, buildRow({ toState: "pending" })),
      );
      expect(await countRows(DEFAULT_TABLE)).toBe(1);
    } finally {
      await small.end();
    }
  });

  it("explains itself when handed something that is not a postgres.js instance", async () => {
    // Guards the diagnostic in postgresJsQueryFn. Handing the factory a
    // `pg` Pool is an easy mistake (both factories live in the same
    // module), and `unsafe()` resolving with a result object instead of
    // an array would otherwise surface as a confusing mapRow failure.
    const notSql: PostgresJsQueryable = {
      unsafe: async () => ({ rows: [] }),
    };
    const adapter = createPostgresJsAdapter({
      ...notSql,
      begin: (fn: (tx: PostgresJsQueryable) => Promise<unknown>) => fn(notSql),
    });
    await expect(
      adapter.withTransaction((tx) => adapter.readCurrent(tx, MACHINE, "subject-1")),
    ).rejects.toThrow(/did not resolve with an array of rows/);
  });
});
