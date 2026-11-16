/**
 * Kysely adapter implementation for stateledger.
 *
 * All persistence goes through Kysely's `sql` template tag and the
 * `.execute()` it hands back. Nothing here touches the typed query builder,
 * so users do not have to add `stateledger_transitions` to their `Database`
 * interface | the adapter happily runs against a `Kysely` typed for a
 * completely unrelated schema. Only the table itself has to exist (see
 * `./schema-sql.ts`).
 *
 * Postgres only. The advisory lock and the partial unique index this adapter
 * leans on are Postgres features, and the `::jsonb` / `::text` casts below
 * are Postgres syntax.
 *
 * Two things differ from the Drizzle adapter and will trip you up if you are
 * porting knowledge across:
 *
 * 1. Opening a transaction is a two-step builder. `db.transaction()` returns
 *    a `TransactionBuilder` that has begun nothing; the work only happens in
 *    `.execute(cb)`. Drizzle's `db.transaction(cb)` takes the callback
 *    directly, so the muscle-memory version (`db.transaction(fn)`) silently
 *    builds a transaction, ignores `fn`, and never runs anything.
 * 2. A Kysely `Transaction` IS a `Kysely` (it extends the class), so you
 *    cannot distinguish a root client from a transaction by probing for a
 *    `.transaction` method: both have one. The discriminator is the
 *    `isTransaction` getter, `false` on a root client and `true` on a
 *    transaction. Probing wrong is not a harmless nested transaction either,
 *    because `Transaction.transaction()` is declared `never` and throws.
 */

import type {
  Adapter,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "@stateledger/core";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import { sql } from "kysely";

import type {
  KyselyAdapterOptions,
  KyselyDb,
  KyselyExecutor,
  KyselyTransactionalClient,
} from "./types.js";

const DEFAULT_TABLE = "stateledger_transitions";

/**
 * Raw row shape coming back from Postgres before we map to `TransitionRow`.
 *
 * Keys are camelCase because the projection below aliases every column, and
 * `sortKey` / `machineVersion` keep the union of representations a Postgres
 * driver may hand over for an INTEGER (pg returns `number`, but a driver
 * configured with a bigint parser returns `bigint` or `string`).
 */
type RawTransitionRow = {
  id: string;
  machine: string;
  subjectId: string;
  fromState: string | null;
  toState: string;
  sortKey: number | bigint | string;
  mostRecent: boolean;
  actorId: string | null;
  actorType: string | null;
  /** JSON text, not an object | see the note on the projection below. */
  metadata: string | null;
  machineVersion: number | bigint | string;
  createdAt: Date | string;
};

/**
 * Column projection shared by every read and by the INSERT's RETURNING.
 *
 * Two deliberate choices here, both forced by the fact that Kysely result
 * plugins apply to raw `sql` queries just as much as to builder queries:
 *
 * - Every column is aliased to the camelCase name `TransitionRow` uses.
 *   `CamelCasePlugin` rewrites the keys of every result row it sees, so a
 *   plain `SELECT *` would deliver `subject_id` on a bare client and
 *   `subjectId` on a plugin-enabled one, and the adapter cannot know which.
 *   Aliasing in SQL pins exactly one shape: the plugin's snake-to-camel
 *   mapper is a no-op on names that contain no underscore, so these aliases
 *   pass through it unchanged either way.
 *
 * - `metadata` comes back as `::text` and we `JSON.parse` it ourselves.
 *   `CamelCasePlugin` recurses into plain-object values, so a jsonb column
 *   would arrive with the *user's own* metadata keys rewritten
 *   (`{ payment_intent: "pi_1" }` turning into `{ paymentIntent: "pi_1" }`).
 *   A string value is left alone, so the round trip through text is what
 *   keeps metadata faithful to what was written.
 *
 * The one thing aliasing cannot defend against is the table name itself:
 * `CamelCasePlugin` snake_cases identifier nodes, so a `tableName` that is
 * not already snake_case would be rewritten under that plugin. The default
 * is snake_case, and the README says to keep overrides that way.
 */
const TRANSITION_COLUMNS = sql`
  id,
  machine,
  subject_id      AS "subjectId",
  from_state      AS "fromState",
  to_state        AS "toState",
  sort_key        AS "sortKey",
  most_recent     AS "mostRecent",
  actor_id        AS "actorId",
  actor_type      AS "actorType",
  metadata::text  AS "metadata",
  machine_version AS "machineVersion",
  created_at      AS "createdAt"
`;

class KyselyAdapter implements Adapter<KyselyExecutor> {
  private readonly tableName: string;
  private readonly locking: "pessimistic" | "optimistic";

  constructor(
    private readonly root: KyselyDb,
    options: KyselyAdapterOptions = {},
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE;
    this.locking = options.locking ?? "pessimistic";
    assertValidIdentifier(this.tableName);
  }

  async withTransaction<R>(fn: (tx: KyselyExecutor) => Promise<R>): Promise<R> {
    if (isTransactionContext(this.root)) {
      // The caller handed us their own transaction, so join it: begin
      // nothing, commit nothing, just run inside what they already opened.
      // Calling `.transaction()` on a Kysely `Transaction` would throw.
      return fn(this.root);
    }

    if (!hasTransactionBuilder(this.root)) {
      throw new AdapterError(
        "createKyselyAdapter received a client that can neither open a transaction " +
          "(no `transaction()` method) nor report itself as one (`isTransaction` is not true). " +
          "Pass a Kysely instance or a Kysely Transaction.",
      );
    }

    // Kysely's transaction API is two-step: `transaction()` only builds the
    // TransactionBuilder (the place isolation level and access mode would be
    // configured) and nothing is sent to the database until `.execute(cb)`
    // runs. The builder commits when `cb` resolves and rolls back when it
    // rejects, re-throwing the original error, which is exactly the contract
    // `Adapter.withTransaction` asks for.
    return this.root.transaction().execute((trx: KyselyExecutor) => fn(trx));
  }

  async acquireLock(
    tx: KyselyExecutor,
    machine: string,
    subjectId: string,
  ): Promise<void> {
    if (this.locking === "optimistic") return;
    const key = `${machine}:${subjectId}`;
    try {
      // `hashtextextended` returns bigint, which `pg_advisory_xact_lock`
      // accepts. The lock auto-releases when the surrounding transaction
      // ends | no explicit unlock is needed (or possible).
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: failed to acquire advisory lock`,
        { cause: err },
      );
    }
  }

  async readCurrent(
    tx: KyselyExecutor,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null> {
    try {
      const { rows } = await sql<RawTransitionRow>`
        SELECT ${TRANSITION_COLUMNS}
          FROM ${sql.table(this.tableName)}
         WHERE machine = ${machine}
           AND subject_id = ${subjectId}
           AND most_recent = TRUE
         LIMIT 1`.execute(tx);
      const row = rows[0];
      return row ? mapRow(row) : null;
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: readCurrent failed`,
        { cause: err },
      );
    }
  }

  async appendTransition(
    tx: KyselyExecutor,
    row: NewTransitionRow,
  ): Promise<TransitionRow> {
    try {
      // Flip the previous mostRecent row (no-op for the bootstrap transition).
      await sql`
        UPDATE ${sql.table(this.tableName)}
           SET most_recent = FALSE
         WHERE machine = ${row.machine}
           AND subject_id = ${row.subjectId}
           AND most_recent = TRUE`.execute(tx);

      // `metadata` is JSON-encoded here and cast on the way in: a `sql`
      // substitution becomes a bound parameter, and the pg driver would send
      // a plain object as a stringified record rather than as jsonb.
      const metadataJson = JSON.stringify(row.metadata ?? {});
      const { rows } = await sql<RawTransitionRow>`
        INSERT INTO ${sql.table(this.tableName)} (
          machine, subject_id, from_state, to_state, sort_key, most_recent,
          actor_id, actor_type, metadata, machine_version
        ) VALUES (
          ${row.machine}, ${row.subjectId}, ${row.fromState}, ${row.toState},
          ${row.sortKey}, ${row.mostRecent},
          ${row.actorId}, ${row.actorType}, ${metadataJson}::jsonb, ${row.machineVersion}
        )
        RETURNING ${TRANSITION_COLUMNS}`.execute(tx);

      const created = rows[0];
      if (!created) {
        throw new AdapterError(
          `[${row.machine}] ${row.subjectId}: INSERT returned no rows`,
        );
      }
      return mapRow(created);
    } catch (err) {
      // The partial unique index on (machine, subject_id) WHERE most_recent = TRUE
      // surfaces lost optimistic races as a unique-constraint violation.
      if (isUniqueViolation(err)) {
        throw new OptimisticConcurrencyError(row.machine, row.subjectId);
      }
      // Re-throw our own errors as-is so callers can match on them.
      if (err instanceof AdapterError || err instanceof OptimisticConcurrencyError) {
        throw err;
      }
      throw new AdapterError(
        `[${row.machine}] ${row.subjectId}: appendTransition failed`,
        { cause: err },
      );
    }
  }

  async readHistory(
    tx: KyselyExecutor | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]> {
    const client = tx ?? this.root;
    try {
      const { rows } = await sql<RawTransitionRow>`
        SELECT ${TRANSITION_COLUMNS}
          FROM ${sql.table(this.tableName)}
         WHERE machine = ${machine}
           AND subject_id = ${subjectId}
         ORDER BY sort_key ASC`.execute(client);
      return rows.map(mapRow);
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: readHistory failed`,
        { cause: err },
      );
    }
  }

  async readStateAt(
    tx: KyselyExecutor | null,
    machine: string,
    subjectId: string,
    at: Date,
  ): Promise<TransitionRow | null> {
    const client = tx ?? this.root;
    try {
      // Most recent transition row whose created_at <= cutoff. Order by
      // sort_key DESC (not created_at DESC) for the tiebreak | sortKey is
      // monotonic per (machine, subjectId) and is the canonical ordering
      // used everywhere else in the library.
      const { rows } = await sql<RawTransitionRow>`
        SELECT ${TRANSITION_COLUMNS}
          FROM ${sql.table(this.tableName)}
         WHERE machine = ${machine}
           AND subject_id = ${subjectId}
           AND created_at <= ${at}
         ORDER BY sort_key DESC
         LIMIT 1`.execute(client);
      const row = rows[0];
      return row ? mapRow(row) : null;
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: readStateAt failed`,
        { cause: err },
      );
    }
  }

  async updateSubjectState(
    tx: KyselyExecutor,
    hint: SubjectStateHint,
    newState: string,
  ): Promise<void> {
    const model = stringField(hint, "model");
    const column = stringField(hint, "column") ?? "state";
    const where = hint["where"];

    if (!model) {
      throw new AdapterError(
        "updateSubjectState: subjectStateColumn.model is required (Postgres table name)",
      );
    }
    if (!where || typeof where !== "object") {
      throw new AdapterError(
        "updateSubjectState: subjectStateColumn.where is required (object of identifying columns)",
      );
    }

    assertValidIdentifier(model);
    assertValidIdentifier(column);

    const whereObj = where as Record<string, unknown>;
    const keys = Object.keys(whereObj);
    if (keys.length === 0) {
      throw new AdapterError(
        "updateSubjectState: subjectStateColumn.where must have at least one column",
      );
    }
    for (const key of keys) assertValidIdentifier(key);

    // Build the WHERE fragment with `sql.join` so every column name stays an
    // identifier node and every value stays a bound parameter. No user value
    // is ever concatenated into the SQL string.
    const whereFragments = keys.map((k) => sql`${sql.ref(k)} = ${whereObj[k]}`);
    const whereSql = sql.join(whereFragments, sql` AND `);

    try {
      await sql`
        UPDATE ${sql.table(model)}
           SET ${sql.ref(column)} = ${newState}
         WHERE ${whereSql}`.execute(tx);
    } catch (err) {
      throw new AdapterError(
        `updateSubjectState failed for ${model}.${column}`,
        { cause: err },
      );
    }
  }
}

/**
 * Create an adapter bound to a Kysely client.
 *
 * Pass a top-level `Kysely` instance for typical use | the adapter will open
 * its own transactions via `db.transaction().execute(...)`. Pass a Kysely
 * `Transaction` to join a transaction the caller opened higher up the stack;
 * the adapter detects it through `isTransaction` and will not try to nest.
 */
export function createKyselyAdapter(
  client: KyselyDb,
  options?: KyselyAdapterOptions,
): Adapter<KyselyExecutor> {
  return new KyselyAdapter(client, options);
}

// ---- internal helpers ----

/**
 * Is this client already inside a transaction?
 *
 * `Transaction` extends `Kysely`, so the only honest signal is the
 * `isTransaction` getter: `false` on a root client, `true` on a transaction
 * (including the controlled transactions `startTransaction()` returns). We
 * compare against `true` rather than coercing, so a user-supplied object that
 * happens to carry a truthy `isTransaction` of some other type does not
 * quietly change the branch taken.
 */
function isTransactionContext(client: KyselyDb): boolean {
  return (client as { isTransaction?: unknown }).isTransaction === true;
}

function hasTransactionBuilder(client: KyselyDb): client is KyselyTransactionalClient {
  return typeof (client as KyselyTransactionalClient).transaction === "function";
}

/**
 * Detect "unique constraint violation" from the Postgres driver error.
 *
 * Kysely does not wrap driver errors: `PostgresDriver` catches, extends the
 * error's `.stack` with the caller's stack for a readable trace, and rethrows
 * the very same object, so SQLSTATE `23505` arrives on `.code` exactly as
 * `pg` set it. The `cause` and `original` branches are kept for the dialects
 * that do nest (PGlite and community dialects wrapping their own client
 * errors), so a lost race is never misreported as a generic AdapterError.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown } | null;
    original?: { code?: unknown } | null;
  };
  if (e.code === "23505") return true;
  if (e.cause && typeof e.cause === "object" && (e.cause as { code?: unknown }).code === "23505") {
    return true;
  }
  if (
    e.original &&
    typeof e.original === "object" &&
    (e.original as { code?: unknown }).code === "23505"
  ) {
    return true;
  }
  return false;
}

function mapRow(raw: RawTransitionRow): TransitionRow {
  return {
    id: raw.id,
    machine: raw.machine,
    subjectId: raw.subjectId,
    fromState: raw.fromState,
    toState: raw.toState,
    sortKey: Number(raw.sortKey),
    mostRecent: raw.mostRecent,
    actorId: raw.actorId,
    actorType: raw.actorType,
    metadata: parseMetadata(raw.metadata),
    machineVersion: Number(raw.machineVersion),
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : new Date(raw.createdAt),
  };
}

/**
 * Turn the `metadata::text` projection back into an object.
 *
 * The column is `NOT NULL DEFAULT '{}'::jsonb`, so in practice this is always
 * a JSON object literal. It is still validated: a row written by something
 * other than this adapter could hold a scalar or an array, and silently
 * handing that back as `Record<string, unknown>` would be a lie the rest of
 * the library would trip over later.
 */
function parseMetadata(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AdapterError("metadata column did not contain valid JSON", { cause: err });
  }
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdapterError(
      `metadata column must hold a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/**
 * Reject table/column names that aren't safe to interpolate into raw SQL.
 *
 * `sql.table()` and `sql.ref()` already emit quoted identifier nodes rather
 * than spliced strings, but we still validate at the boundary so a
 * misconfigured hint fails loud and early instead of at query time. The
 * pattern also rules out dots, which those helpers would otherwise read as a
 * schema or table qualifier.
 *
 * The length check is a separate failure mode from the pattern: Postgres
 * silently truncates identifiers to NAMEDATALEN - 1 (63) bytes, so a longer
 * name is not an error at the database, it just quietly addresses a
 * different relation than the one that was configured. The pattern restricts
 * names to ASCII, so character count is byte count here.
 */
const MAX_IDENTIFIER_LENGTH = 63;

function assertValidIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} is ${name.length} characters; ` +
        `Postgres truncates identifiers to ${MAX_IDENTIFIER_LENGTH} and would address a different relation`,
    );
  }
}
