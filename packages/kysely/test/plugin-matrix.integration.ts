/**
 * Plugin-matrix integration suite for the Kysely adapter.
 *
 * Kysely plugins apply to raw `sql` fragments exactly as they do to builder
 * queries: `transformQuery` rewrites identifier nodes on the way in and
 * `transformResult` rewrites result-row keys on the way out. The adapter is
 * built around that fact (every column is aliased in SQL, `metadata` is read
 * as `::text`), so the plugin a user happens to have installed must not change
 * a single byte of what the adapter returns.
 *
 * These assertions started life as throwaway `DummyDriver` tests against a
 * canned result row. They are here as permanent integration tests because the
 * canned version could not see what Postgres actually stores, nor whether the
 * rewritten table identifier resolves to a real relation.
 *
 * Run locally (needs Docker):
 *   pnpm --filter @stateledger/kysely test:integration
 */

import type { Adapter, TransitionRow } from "@stateledger/core";
import { AdapterError } from "@stateledger/core";
import { CamelCasePlugin, sql, type Kysely } from "kysely";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createKyselyAdapter } from "../src/index.js";
import type { KyselyExecutor } from "../src/types.js";
import {
  applyLedgerSchema,
  connect,
  newRow,
  startPostgres,
  withoutGeneratedFields,
  type TestDatabase,
} from "./support/postgres.js";

const MACHINE = "plugin-machine";

/**
 * One table per client, so a cross-client comparison is comparing two
 * independent round trips rather than two reads of one row.
 *
 * The `upperCase` client's table is UPPERCASE on purpose: see the caveat
 * tests at the bottom of this file. Its adapter is configured with the
 * lowercase name `plugin_upper_ledger`, which the plugin rewrites.
 */
const PLAIN_LEDGER = "plugin_plain_ledger";
const CAMEL_LEDGER = "plugin_camel_ledger";
const UPPER_LEDGER_CONFIGURED = "plugin_upper_ledger";
const UPPER_LEDGER_PHYSICAL = "PLUGIN_UPPER_LEDGER";
/** Physical table a camelCase `tableName` resolves to under CamelCasePlugin. */
const CAMEL_NAMED_PHYSICAL = "camel_named_ledger";

let container: StartedTestContainer;
let plainDb: Kysely<TestDatabase>;
let camelDb: Kysely<TestDatabase>;
let upperDb: Kysely<TestDatabase>;

type Variant = {
  label: string;
  db: () => Kysely<TestDatabase>;
  /** What `tableName` the adapter is configured with. */
  configuredTable: string;
  /** Where the rows actually land once the plugin has had its say. */
  physicalTable: string;
};

const VARIANTS: readonly Variant[] = [
  {
    label: "no plugin",
    db: () => plainDb,
    configuredTable: PLAIN_LEDGER,
    physicalTable: PLAIN_LEDGER,
  },
  {
    label: "CamelCasePlugin()",
    db: () => camelDb,
    configuredTable: CAMEL_LEDGER,
    physicalTable: CAMEL_LEDGER,
  },
  {
    label: "CamelCasePlugin({ upperCase: true })",
    db: () => upperDb,
    configuredTable: UPPER_LEDGER_CONFIGURED,
    physicalTable: UPPER_LEDGER_PHYSICAL,
  },
];

/**
 * The metadata that broke the naive implementation: snake_case keys at the top
 * level and nested, plus an array of objects. `CamelCasePlugin.transformResult`
 * recurses into plain objects and into arrays of plain objects, so a `metadata`
 * column returned as jsonb (rather than as `::text`) comes back with the USER'S
 * keys rewritten: `payment_intent` to `paymentIntent`.
 */
const METADATA = {
  payment_intent: "pi_1",
  nested: { snake_key: "kept", deeper: { another_key: 1 } },
  rows: [{ in_array: "yes" }, { also_snake: false }],
  already_camel: { keepMe: true },
  unicode: "café ☕",
};

beforeAll(async () => {
  const pg = await startPostgres();
  container = pg.container;

  ({ db: plainDb } = connect(pg.connectionString));
  ({ db: camelDb } = connect(pg.connectionString, [new CamelCasePlugin()]));
  ({ db: upperDb } = connect(pg.connectionString, [new CamelCasePlugin({ upperCase: true })]));

  // DDL goes through `sql.raw`, which is a single raw string with no
  // identifier nodes in it, so no plugin can rewrite these names.
  for (const table of [
    PLAIN_LEDGER,
    CAMEL_LEDGER,
    UPPER_LEDGER_PHYSICAL,
    UPPER_LEDGER_CONFIGURED,
    CAMEL_NAMED_PHYSICAL,
  ]) {
    await applyLedgerSchema(plainDb, table);
  }

  await sql`
    CREATE TABLE payments (
      id         TEXT    PRIMARY KEY,
      tenant_id  INTEGER NOT NULL,
      state      TEXT    NOT NULL
    )`.execute(plainDb);
}, 180_000);

afterAll(async () => {
  await plainDb?.destroy();
  await camelDb?.destroy();
  await upperDb?.destroy();
  await container?.stop();
});

beforeEach(async () => {
  for (const table of [
    PLAIN_LEDGER,
    CAMEL_LEDGER,
    UPPER_LEDGER_PHYSICAL,
    UPPER_LEDGER_CONFIGURED,
    CAMEL_NAMED_PHYSICAL,
  ]) {
    await sql`TRUNCATE ${sql.table(table)}`.execute(plainDb);
  }
  await sql`TRUNCATE payments`.execute(plainDb);
  await sql`INSERT INTO payments (id, tenant_id, state) VALUES ('pay-1', 42, 'pending')`.execute(
    plainDb,
  );
});

async function countRows(table: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(plainDb);
  return rows[0]?.n ?? 0;
}

/** Write one subject's two-step history and read it back every way we can. */
async function writeAndRead(
  adapter: Adapter<KyselyExecutor>,
  subjectId: string,
): Promise<{
  inserted: TransitionRow;
  current: TransitionRow | null;
  history: TransitionRow[];
  at: TransitionRow | null;
}> {
  const inserted = await adapter.withTransaction(async (tx) => {
    // `acquireLock` is raw SQL with no identifier nodes, but running it here
    // proves no plugin breaks the advisory-lock statement either.
    await adapter.acquireLock(tx, MACHINE, subjectId);
    return adapter.appendTransition(
      tx,
      newRow({
        machine: MACHINE,
        subjectId,
        toState: "pending",
        actorId: "actor-1",
        actorType: "USER",
        metadata: METADATA,
      }),
    );
  });

  const current = await adapter.withTransaction(async (tx) =>
    adapter.readCurrent(tx, MACHINE, subjectId),
  );
  const history = await adapter.readHistory(null, MACHINE, subjectId);
  const at = await adapter.readStateAt(null, MACHINE, subjectId, new Date(Date.now() + 60_000));
  return { inserted, current, history, at };
}

const TRANSITION_KEYS = [
  "actorId",
  "actorType",
  "createdAt",
  "fromState",
  "id",
  "machine",
  "machineVersion",
  "metadata",
  "mostRecent",
  "sortKey",
  "subjectId",
  "toState",
];

describe("CamelCasePlugin matrix", () => {
  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      it("returns a fully populated TransitionRow with camelCase keys", async () => {
        // Without the SQL aliases in `TRANSITION_COLUMNS`, a bare `SELECT *`
        // would deliver `subject_id` on the plain client and `subjectId` on a
        // CamelCasePlugin client. `mapRow` reads camelCase, so one of the two
        // would quietly produce a row full of `undefined` that still satisfies
        // the `TransitionRow` type.
        const adapter = createKyselyAdapter(variant.db(), {
          tableName: variant.configuredTable,
        });
        const { inserted, current, history, at } = await writeAndRead(adapter, "shape");

        expect(Object.keys(inserted).sort()).toEqual(TRANSITION_KEYS);
        for (const row of [inserted, current, history[0], at]) {
          expect(row?.machine).toBe(MACHINE);
          expect(row?.subjectId).toBe("shape");
          expect(row?.fromState).toBeNull();
          expect(row?.toState).toBe("pending");
          expect(row?.sortKey).toBe(1);
          expect(row?.mostRecent).toBe(true);
          expect(row?.actorId).toBe("actor-1");
          expect(row?.actorType).toBe("USER");
          expect(row?.machineVersion).toBe(1);
          expect(row?.createdAt).toBeInstanceOf(Date);
          expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
        }

        // And the rows really are in the table the plugin pointed us at.
        expect(await countRows(variant.physicalTable)).toBe(1);
      });

      it("does not rewrite the keys of the user's own metadata", async () => {
        // The regression this file exists for. `CamelCasePlugin` recurses into
        // plain objects and arrays of plain objects in every result row, so a
        // jsonb `metadata` column would come back as
        // `{ paymentIntent, nested: { snakeKey } }` and the caller's
        // `metadata.payment_intent` would read `undefined`. Reading the column
        // as `::text` and parsing it here is what prevents that, and it has to
        // hold on all four read paths.
        const adapter = createKyselyAdapter(variant.db(), {
          tableName: variant.configuredTable,
        });
        const { inserted, current, history, at } = await writeAndRead(adapter, "metadata");

        for (const row of [inserted, current, history[0], at]) {
          expect(row?.metadata).toEqual(METADATA);
          expect(Object.keys(row?.metadata ?? {}).sort()).toEqual([
            "already_camel",
            "nested",
            "payment_intent",
            "rows",
            "unicode",
          ]);
        }

        // Stored as a real jsonb object, so the user's own jsonb queries see
        // the same keys the adapter hands back.
        const { rows } = await sql<{ t: string; intent: string | null }>`
          SELECT jsonb_typeof(metadata) AS t, metadata->>'payment_intent' AS intent
            FROM ${sql.table(variant.physicalTable)} WHERE id = ${inserted.id}`.execute(plainDb);
        expect(rows[0]?.t).toBe("object");
        expect(rows[0]?.intent).toBe("pi_1");
      });
    });
  }

  it("produces byte-identical rows across all three clients", async () => {
    // The matrix assertion: same input, three different plugin
    // configurations, one output shape. Compared field by field (minus the
    // database-assigned `id` and `createdAt`) so a plugin that changed a
    // value's type (a boolean arriving as a string, a number as a bigint)
    // cannot hide behind a per-client assertion.
    const results = [];
    for (const variant of VARIANTS) {
      const adapter = createKyselyAdapter(variant.db(), { tableName: variant.configuredTable });
      const { inserted } = await writeAndRead(adapter, "identical");
      results.push(withoutGeneratedFields({ ...inserted }));
    }

    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});

describe("the identifier caveat CamelCasePlugin cannot be aliased around", () => {
  it("snake_cases a camelCase tableName, so it resolves to the snake_case table", async () => {
    // The README caveat, pinned. `sql.table()` emits an identifier node and
    // `CamelCasePlugin` rewrites every identifier node, table names included.
    // A user who writes `tableName: "camelNamedLedger"` under this plugin is
    // really addressing `camel_named_ledger`, which is why the docs say to
    // keep custom table names snake_case.
    const adapter = createKyselyAdapter(camelDb, { tableName: "camelNamedLedger" });
    await adapter.withTransaction(async (tx) => {
      await adapter.appendTransition(
        tx,
        newRow({ machine: MACHINE, subjectId: "caveat", toState: "pending" }),
      );
    });

    expect(await countRows(CAMEL_NAMED_PHYSICAL)).toBe(1);
  });

  it("fails on the same camelCase tableName without the plugin", async () => {
    // The other side of the caveat: nothing rewrites the name on a plain
    // client, so the quoted identifier `"camelNamedLedger"` is a relation
    // that does not exist. The same config is therefore valid under one
    // client and broken under another, which is exactly why this is a
    // documented caveat rather than something the adapter can paper over.
    const adapter = createKyselyAdapter(plainDb, { tableName: "camelNamedLedger" });
    await expect(
      adapter.withTransaction(async (tx) =>
        adapter.appendTransition(
          tx,
          newRow({ machine: MACHINE, subjectId: "caveat", toState: "pending" }),
        ),
      ),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(await countRows(CAMEL_NAMED_PHYSICAL)).toBe(0);
  });

  it("keeps a snake_case tableName identical on plain and CamelCasePlugin clients", async () => {
    // Why the default name is safe: the snake-case mapper is a no-op on a
    // name that has no uppercase letters, so `stateledger_transitions` (and
    // any snake_case override) means the same table on both clients.
    for (const client of [plainDb, camelDb]) {
      const adapter = createKyselyAdapter(client, { tableName: PLAIN_LEDGER });
      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(
          tx,
          newRow({
            machine: MACHINE,
            subjectId: client === plainDb ? "snake-plain" : "snake-camel",
            toState: "pending",
          }),
        );
      });
    }
    expect(await countRows(PLAIN_LEDGER)).toBe(2);
  });

  it("UPPERCASES even a snake_case tableName under upperCase: true", async () => {
    // Sharper than the README caveat: with `upperCase: true` the mapper
    // uppercases its output, so a perfectly snake_case `tableName` is still
    // rewritten and the adapter addresses "PLUGIN_UPPER_LEDGER" rather than
    // the lowercase table of the same name. Both tables exist here to prove
    // which one is written, and that the lowercase one is left empty.
    const adapter = createKyselyAdapter(upperDb, { tableName: UPPER_LEDGER_CONFIGURED });
    await adapter.withTransaction(async (tx) => {
      await adapter.appendTransition(
        tx,
        newRow({ machine: MACHINE, subjectId: "upper", toState: "pending" }),
      );
    });

    expect(await countRows(UPPER_LEDGER_PHYSICAL)).toBe(1);
    expect(await countRows(UPPER_LEDGER_CONFIGURED)).toBe(0);
  });

  it("rewrites updateSubjectState identifiers the same way", async () => {
    // `updateSubjectState` takes PHYSICAL names from the machine config and
    // passes them through `sql.table()` / `sql.ref()`, so the same rewriting
    // applies to the subject table, its state column and every `where` key.
    // snake_case names survive CamelCasePlugin untouched; under
    // `upperCase: true` the lowercase `payments` table becomes "PAYMENTS" and
    // the statement fails, which must surface as AdapterError.
    const run = async (client: Kysely<TestDatabase>, state: string): Promise<void> => {
      const adapter = createKyselyAdapter(client);
      const update = adapter.updateSubjectState;
      if (!update) throw new Error("adapter must implement updateSubjectState");
      await adapter.withTransaction(async (tx) => {
        await update.call(
          adapter,
          tx,
          { model: "payments", column: "state", where: { tenant_id: 42, id: "pay-1" } },
          state,
        );
      });
    };

    await run(plainDb, "settled-plain");
    const afterPlain = await sql<{ state: string }>`
      SELECT state FROM payments WHERE id = 'pay-1'`.execute(plainDb);
    expect(afterPlain.rows[0]?.state).toBe("settled-plain");

    await run(camelDb, "settled-camel");
    const afterCamel = await sql<{ state: string }>`
      SELECT state FROM payments WHERE id = 'pay-1'`.execute(plainDb);
    expect(afterCamel.rows[0]?.state).toBe("settled-camel");

    await expect(run(upperDb, "settled-upper")).rejects.toBeInstanceOf(AdapterError);
    const afterUpper = await sql<{ state: string }>`
      SELECT state FROM payments WHERE id = 'pay-1'`.execute(plainDb);
    expect(afterUpper.rows[0]?.state).toBe("settled-camel");
  });
});
