/**
 * TypeORM adapter implementation for stateledger.
 *
 * All persistence goes through `manager.query(text, params)` with Postgres
 * numbered placeholders (`$1`, `$2`, ...). The adapter deliberately avoids
 * entity classes, repositories and the query builder: the transitions table
 * is managed by raw DDL (see `./schema-sql.ts`), so there is nothing for
 * TypeORM's metadata layer to know about, and nothing for `synchronize: true`
 * to touch.
 *
 * Structural typing means both the 0.3.x and 1.x lines of TypeORM satisfy the
 * `TypeormClient` contract via duck typing | see the header of `./types.ts`.
 */

import type {
  Adapter,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "@stateledger/core";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";

import type {
  TypeormAdapterOptions,
  TypeormClient,
  TypeormDataSourceLike,
  TypeormEntityManagerLike,
  TypeormExecutor,
} from "./types.js";

const DEFAULT_TABLE = "stateledger_transitions";

/** Postgres NAMEDATALEN - 1. Identifiers longer than this are truncated, not rejected. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Raw row shape returned by Postgres before we map to `TransitionRow`.
 *
 * The `pg` driver parses `TIMESTAMPTZ` into a `Date` and `JSONB` into a plain
 * object, but `sort_key` / `machine_version` can arrive as a string when the
 * column is widened to `BIGINT` in a user's own migration, so both are
 * normalized through `Number()` in `mapRow`.
 */
type RawTransitionRow = {
  id: string;
  machine: string;
  subject_id: string;
  from_state: string | null;
  to_state: string;
  sort_key: number | bigint | string;
  most_recent: boolean;
  actor_id: string | null;
  actor_type: string | null;
  metadata: Record<string, unknown> | null;
  machine_version: number | bigint | string;
  created_at: Date | string;
};

class TypeormAdapter implements Adapter<TypeormExecutor> {
  private readonly table: string;
  private readonly locking: "pessimistic" | "optimistic";

  constructor(
    private readonly root: TypeormClient,
    options: TypeormAdapterOptions = {},
  ) {
    // Pre-quote once. Postgres does not accept a bound parameter in table
    // position, so this value is concatenated into every statement, which is
    // why it goes through `quoteIdentifier` (which validates) and never a
    // bare interpolation.
    this.table = quoteIdentifier(options.tableName ?? DEFAULT_TABLE);
    this.locking = options.locking ?? "pessimistic";
  }

  /**
   * THE correctness trap in this adapter: the advisory lock and the INSERT it
   * protects must run on the same database connection, inside the same
   * transaction. If they land on two pooled connections the lock is taken and
   * released somewhere else entirely and guards nothing, while the test suite
   * still passes because the lock call itself succeeded.
   *
   * Two things make that safe here:
   *
   * 1. `transaction()` (on either a `DataSource` or an `EntityManager`) pins
   *    exactly one `QueryRunner` for the whole callback and calls back with an
   *    `EntityManager` bound to it. `EntityManager#query` forwards that runner
   *    down to the driver, so every statement in the callback | lock, SELECT,
   *    UPDATE, INSERT | runs on one connection.
   * 2. We therefore hand that scoped manager out as the `TxHandle` and never
   *    fall back to the root client for a write. `DataSource#query` without a
   *    runner checks a connection out of the pool and releases it immediately
   *    after the statement, which is precisely the broken case above: a
   *    `pg_advisory_xact_lock` taken that way is released before the next
   *    statement even starts.
   *
   * TypeORM also exposes the explicit route (`createQueryRunner()` plus
   * `startTransaction` / `commitTransaction` / `rollbackTransaction` /
   * `release`). It gives the same connection affinity, so it would be equally
   * correct, but it puts the release in our hands: a thrown rollback error or
   * an early return leaks a pooled connection, and in a long-lived service
   * that eventually exhausts the pool. `transaction()` already does the
   * commit, the rollback-on-throw, and the release in a `finally`, so we use
   * it and keep the error handling in one place.
   */
  async withTransaction<R>(fn: (tx: TypeormExecutor) => Promise<R>): Promise<R> {
    if (isLiveTransactionContext(this.root)) {
      // The caller handed us an EntityManager that is already inside a
      // transaction (the NestJS case: a service method running in an existing
      // transactional boundary). Join it. Calling `transaction()` here would
      // instead open a SAVEPOINT on the same runner, which silently changes
      // the rollback semantics the caller asked for.
      return fn(this.root);
    }
    return this.root.transaction((manager: TypeormExecutor) => fn(manager));
  }

  async acquireLock(
    tx: TypeormExecutor,
    machine: string,
    subjectId: string,
  ): Promise<void> {
    if (this.locking === "optimistic") return;
    const key = `${machine}:${subjectId}`;
    try {
      // `hashtextextended` returns bigint, which `pg_advisory_xact_lock`
      // accepts. The lock auto-releases when the surrounding transaction
      // ends | no explicit unlock is needed (or possible).
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: failed to acquire advisory lock`,
        { cause: err },
      );
    }
  }

  async readCurrent(
    tx: TypeormExecutor,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null> {
    try {
      const rows = await selectRows<RawTransitionRow>(
        tx,
        `SELECT * FROM ${this.table}
            WHERE machine = $1
              AND subject_id = $2
              AND most_recent = TRUE
            LIMIT 1`,
        [machine, subjectId],
      );
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
    tx: TypeormExecutor,
    row: NewTransitionRow,
  ): Promise<TransitionRow> {
    try {
      // Flip the previous mostRecent row (no-op for the bootstrap transition).
      // The result is discarded on purpose: TypeORM's Postgres query runner
      // returns `[rows, rowCount]` for UPDATE and DELETE rather than a row
      // list, so this one must not go through `selectRows`.
      await tx.query(
        `UPDATE ${this.table}
              SET most_recent = FALSE
            WHERE machine = $1
              AND subject_id = $2
              AND most_recent = TRUE`,
        [row.machine, row.subjectId],
      );

      // Insert the new row and return it. `metadata` is JSON-encoded and cast
      // explicitly because the parameter reaches the driver as an untyped
      // placeholder; leaving the serialization to the driver works for plain
      // objects but not for the `null` default, so we normalize here.
      const metadataJson = JSON.stringify(row.metadata ?? {});
      const inserted = await selectRows<RawTransitionRow>(
        tx,
        `INSERT INTO ${this.table} (
              machine, subject_id, from_state, to_state, sort_key, most_recent,
              actor_id, actor_type, metadata, machine_version
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10
            )
            RETURNING *`,
        [
          row.machine,
          row.subjectId,
          row.fromState,
          row.toState,
          row.sortKey,
          row.mostRecent,
          row.actorId,
          row.actorType,
          metadataJson,
          row.machineVersion,
        ],
      );

      const created = inserted[0];
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
    tx: TypeormExecutor | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]> {
    const client = tx ?? this.root;
    try {
      const rows = await selectRows<RawTransitionRow>(
        client,
        `SELECT * FROM ${this.table}
            WHERE machine = $1
              AND subject_id = $2
            ORDER BY sort_key ASC`,
        [machine, subjectId],
      );
      return rows.map(mapRow);
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: readHistory failed`,
        { cause: err },
      );
    }
  }

  async readStateAt(
    tx: TypeormExecutor | null,
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
      const rows = await selectRows<RawTransitionRow>(
        client,
        `SELECT * FROM ${this.table}
            WHERE machine = $1
              AND subject_id = $2
              AND created_at <= $3
            ORDER BY sort_key DESC
            LIMIT 1`,
        [machine, subjectId, at],
      );
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
    tx: TypeormExecutor,
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

    const whereObj = where as Record<string, unknown>;
    const keys = Object.keys(whereObj);
    if (keys.length === 0) {
      throw new AdapterError(
        "updateSubjectState: subjectStateColumn.where must have at least one column",
      );
    }
    // Table and column names become quoted identifiers, validated by
    // `quoteIdentifier`; the values stay bound parameters. `$1` is the new
    // state, so the WHERE values start at `$2`. All of this happens before
    // the try block so a bad identifier fails as itself rather than being
    // re-wrapped as a query failure.
    const quotedModel = quoteIdentifier(model);
    const quotedColumn = quoteIdentifier(column);
    const whereSql = keys
      .map((key, i) => `${quoteIdentifier(key)} = $${i + 2}`)
      .join(" AND ");
    const params: unknown[] = [newState, ...keys.map((key) => whereObj[key])];

    try {
      await tx.query(
        `UPDATE ${quotedModel}
              SET ${quotedColumn} = $1
            WHERE ${whereSql}`,
        params,
      );
    } catch (err) {
      throw new AdapterError(
        `updateSubjectState failed for ${model}.${column}`,
        { cause: err },
      );
    }
  }
}

/**
 * Create an adapter bound to a TypeORM client.
 *
 * Pass a `DataSource` for typical use | the adapter opens its own
 * transactions via `dataSource.transaction()`:
 *
 * ```ts
 * const adapter = createTypeormAdapter(dataSource);
 * ```
 *
 * Pass a transaction-scoped `EntityManager` to join a transaction the caller
 * already opened higher up the stack, which is how most TypeORM and NestJS
 * code will reach for this:
 *
 * ```ts
 * await dataSource.transaction(async (manager) => {
 *   const adapter = createTypeormAdapter(manager); // joins the outer tx
 *   // ...
 * });
 * ```
 *
 * The `DataSource`'s global manager (`dataSource.manager`) is accepted too
 * and behaves like the `DataSource` itself: it has no transaction of its own
 * to join, so the adapter opens one.
 */
export function createTypeormAdapter(
  client: TypeormClient,
  options?: TypeormAdapterOptions,
): Adapter<TypeormExecutor> {
  return new TypeormAdapter(client, options);
}

// ---- internal helpers ----

/**
 * Is this a `DataSource` rather than an `EntityManager`?
 *
 * `createQueryRunner()` is the discriminator: `DataSource` declares it,
 * `EntityManager` declares neither it nor anything like it (it only takes a
 * runner, in its constructor). Checked against the installed 1.x typings;
 * 0.3 draws the same line.
 */
function isDataSourceLike(client: TypeormClient): client is TypeormDataSourceLike {
  return (
    typeof (client as TypeormDataSourceLike).createQueryRunner === "function"
  );
}

/**
 * Is this an `EntityManager` that is already inside a live transaction?
 *
 * A transaction-scoped manager carries the `QueryRunner` it is pinned to, and
 * that runner reports `isTransactionActive`. Three cases fall out:
 *
 * - `DataSource`: no, open our own transaction.
 * - global `EntityManager` (no runner): no, open our own transaction. Its
 *   `transaction()` creates a runner and pins it for us.
 * - runner-bound `EntityManager`: join it only when a transaction is actually
 *   active. A manager built from a bare `createQueryRunner()` with no
 *   `startTransaction` has nothing to join, and joining it would leave every
 *   statement in autocommit | where `pg_advisory_xact_lock` is released at
 *   the end of each statement and protects nothing. In that case we let
 *   `transaction()` start a real transaction, which TypeORM runs on that same
 *   runner, so connection affinity still holds.
 */
function isLiveTransactionContext(
  client: TypeormClient,
): client is TypeormEntityManagerLike {
  if (isDataSourceLike(client)) return false;
  const runner = (client as TypeormEntityManagerLike).queryRunner;
  return !!runner && runner.isTransactionActive === true;
}

/**
 * Run a row-returning statement (`SELECT` or `INSERT ... RETURNING`) and
 * normalize the result to a row array.
 *
 * TypeORM's Postgres query runner hands back `pg`'s `result.rows` directly,
 * so the happy path is already an array | unlike node-postgres, there is no
 * `{ rows }` wrapper to unwrap. The check stays anyway because a statement
 * returning no rows at all resolves to a `QueryResult` instance, and because
 * `UPDATE` / `DELETE` resolve to `[rows, rowCount]`, so passing a non-select
 * through here would quietly produce nonsense. Failing loudly is better.
 */
async function selectRows<T>(
  executor: TypeormExecutor,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const result = await executor.query<unknown>(sql, params);
  if (Array.isArray(result)) return result as T[];
  throw new AdapterError(
    "Unexpected query() result shape: expected an array of rows. " +
      "Is this a TypeORM Postgres DataSource or EntityManager?",
  );
}

/**
 * Detect "unique constraint violation" from the Postgres driver error.
 *
 * Postgres reports it as SQLSTATE `23505`, but TypeORM is the adapter most
 * likely to re-wrap the driver error instead of passing it through: every
 * failed statement comes back as a `QueryFailedError`. That class copies the
 * driver error's own enumerable properties onto itself, so `.code` is
 * normally present at the top level, and it also keeps the untouched
 * original on `.driverError`. We check both, plus `.cause` and `.original`
 * for the other ORMs' nesting conventions, because a user may well hand us
 * a manager wrapped by something else again.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown } | null;
    original?: { code?: unknown } | null;
    driverError?: { code?: unknown } | null;
  };
  if (e.code === "23505") return true;
  for (const nested of [e.cause, e.original, e.driverError]) {
    if (nested && typeof nested === "object" && (nested as { code?: unknown }).code === "23505") {
      return true;
    }
  }
  return false;
}

function mapRow(raw: RawTransitionRow): TransitionRow {
  return {
    id: raw.id,
    machine: raw.machine,
    subjectId: raw.subject_id,
    fromState: raw.from_state,
    toState: raw.to_state,
    sortKey: Number(raw.sort_key),
    mostRecent: raw.most_recent,
    actorId: raw.actor_id,
    actorType: raw.actor_type,
    metadata: raw.metadata ?? {},
    machineVersion: Number(raw.machine_version),
    createdAt: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
  };
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/**
 * Reject table/column names that aren't safe to interpolate into raw SQL.
 *
 * There is no `sql.identifier()` helper to lean on here the way the Drizzle
 * adapter does, so this is the only thing standing between a configured
 * `tableName` (or a `subjectStateColumn` hint) and string-concatenated SQL.
 * Allow a plain unqualified identifier and nothing else: no quotes, no dots,
 * no whitespace, no schema qualification, and nothing longer than Postgres
 * will actually store. Anything that needs quoting to be legal is rejected
 * rather than escaped, because escaping invites the next reader to assume
 * arbitrary input is handled.
 */
function assertValidIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
  // Postgres does not reject an over-long identifier, it silently truncates it
  // to NAMEDATALEN - 1 = 63 bytes. A 70-character `tableName` would therefore
  // address a table whose real name is its first 63 characters, and two
  // distinct configured names sharing a 63-character prefix would quietly
  // resolve to the same physical table. The pattern above is ASCII-only, so
  // character length is byte length here.
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} is ${name.length} characters; ` +
        `Postgres truncates identifiers at ${MAX_IDENTIFIER_LENGTH} bytes`,
    );
  }
}

/**
 * Wrap a validated identifier in double quotes.
 *
 * Quoting matters even for names that look safe: it keeps the identifier
 * case-sensitive and stops Postgres from folding `MyTable` to `mytable`,
 * which is the usual surprise when a table was created from quoted DDL.
 * Only ever called on a name that already passed `assertValidIdentifier`,
 * so there is no embedded quote left to escape.
 */
function quoteIdentifier(name: string): string {
  assertValidIdentifier(name);
  return `"${name}"`;
}
