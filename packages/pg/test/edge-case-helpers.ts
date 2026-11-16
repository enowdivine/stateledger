/**
 * Shared fixtures for the two edge-case integration suites.
 *
 * Not named `*.integration.ts` on purpose | the integration vitest config
 * collects that glob as test files, and this module has no tests in it.
 *
 * Both suites boot their own container (same as the contract packs do):
 * vitest gives every test file its own module registry, so a shared
 * container would have to be torn down by whichever file happened to
 * finish last.
 */

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import type { Adapter, NewTransitionRow } from "@stateledger/core";

import { STATELEDGER_SCHEMA_STATEMENTS } from "../src/index.js";

export const MACHINE = "edge-machine";

/** Table the adapter uses when `tableName` is not overridden. */
export const DEFAULT_TABLE = "stateledger_transitions";

/** Table the custom-`tableName` tests point the adapter at. */
export const CUSTOM_TABLE = "tenant_a_transitions";

/**
 * Side table for `updateSubjectState`. Deliberately has two candidate
 * identifying columns (so a composite `where` can be exercised) and two
 * state-ish columns (so the default `state` and an explicit `column` can
 * both be exercised).
 */
export const SIDE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "payments" (
    id               TEXT NOT NULL,
    tenant           TEXT NOT NULL,
    state            TEXT,
    lifecycle_state  TEXT,
    PRIMARY KEY (id, tenant)
  )`;

export type StartedPostgres = {
  container: StartedTestContainer;
  connectionString: string;
};

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "stateledger",
      POSTGRES_PASSWORD: "stateledger",
      POSTGRES_DB: "stateledger_test",
    })
    // Wait for the 2nd occurrence: the first is the init-script bootstrap
    // server, which shuts down again before the real one comes up.
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

/**
 * The shipped DDL retargeted at another table name, indexes included.
 *
 * Used by the custom-`tableName` tests. Rewriting the shipped statements
 * rather than hand-writing a second schema is the point: if the DDL and
 * the adapter's column projection ever drift apart, the custom-table test
 * fails for the same reason the default-table one would.
 */
export function schemaFor(tableName: string): string[] {
  return STATELEDGER_SCHEMA_STATEMENTS.map((stmt) => stmt.replaceAll(DEFAULT_TABLE, tableName));
}

/** A `NewTransitionRow` with everything but `toState` defaulted. */
export function buildRow(
  overrides: Partial<NewTransitionRow> & { toState: string },
): NewTransitionRow {
  return {
    machine: MACHINE,
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
 * Identifiers `quoteIdentifier` must reject outright rather than escape.
 *
 * Every entry is a real way a configurable table or column name goes
 * wrong. The two that are not obviously hostile matter most:
 *
 * - `app.transitions`: schema qualification would end up double-quoted as
 *   one atom (`"app.transitions"`), which is a table literally named
 *   `app.transitions`, not `transitions` in schema `app`. Accepting it
 *   would route every write somewhere the user did not mean.
 * - the 64-character name: Postgres truncates identifiers at NAMEDATALEN-1
 *   (63) *silently*, so a 64-character `tableName` would read and write a
 *   different table than the one the user asked for, with no error.
 */
export const HOSTILE_IDENTIFIERS: Array<[label: string, value: string]> = [
  ["double quote", 'tbl"name'],
  ["quote + injected statement", 'x"; DROP TABLE "stateledger_transitions'],
  ["semicolon", "tbl;DROP TABLE stateledger_transitions"],
  ["schema-qualified (dot)", "app.transitions"],
  ["leading digit", "1table"],
  ["empty string", ""],
  ["64 characters (NAMEDATALEN limit is 63)", "a".repeat(64)],
  ["whitespace", "tbl name"],
  ["hyphen", "tbl-name"],
  ["SQL comment", "tbl--x"],
  ["non-ASCII", "tablé"],
];

/** Longest identifier Postgres stores without truncating. Must be accepted. */
export const MAX_LENGTH_IDENTIFIER = "a".repeat(63);

/**
 * `updateSubjectState` is optional on the `Adapter` interface, so calling
 * it through `?.()` would make a test that is meant to exercise it pass
 * silently when it is missing. Resolve it once, loudly.
 */
export function requireUpdateSubjectState<TxHandle>(
  adapter: Adapter<TxHandle>,
): (tx: TxHandle, hint: Record<string, unknown>, newState: string) => Promise<void> {
  const fn = adapter.updateSubjectState;
  if (!fn) throw new Error("this adapter is expected to implement updateSubjectState");
  return fn.bind(adapter);
}

/**
 * A metadata payload that exercises every JSON shape the jsonb column has
 * to survive, in one object. Round-tripping this is the regression test
 * for the two parameter-binding bugs this repo has already shipped: the
 * postgres.js double-encode (metadata arriving as a JSON *string*) and
 * the described-OID serializer rejecting values it was handed.
 *
 * `snake_cased_key` and `nested.inner_key` are the load-bearing ones for
 * postgres.js: its `transform: postgres.camel` rewrites the keys of json
 * and jsonb *values*, so these only survive because the adapter projects
 * `metadata::text` (OID 25) instead of jsonb (OID 3802).
 */
export const RICH_METADATA: Record<string, unknown> = {
  snake_cased_key: "kept",
  nested: { inner_key: { deeper: [1, 2, { leaf_key: true }] } },
  list: [1, "two", null, false, { three: 3 }],
  unicode: "héllo 世界 🙂",
  quoted: 'he said "hi" \\ then left',
  looks_like_a_placeholder: "$1, $2; --",
  empty_object: {},
  empty_list: [],
  zero: 0,
  nullish: null,
  truthy: true,
  big_number: 9007199254740991,
  float: 1.5,
};
