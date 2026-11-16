/**
 * Raw-Postgres adapter implementation for stateledger.
 *
 * Two drivers, two public factories, one implementation. `createPgAdapter`
 * targets node-postgres (`pg`) and `createPostgresJsAdapter` targets
 * postgres.js (`postgres`). Everything that could possibly be shared is:
 * the SQL text, the identifier quoting, the row mapping, the advisory
 * locking, and the error translation all live in `PgAdapter` below, which
 * talks to the driver through a tiny {@link Backend} seam.
 *
 * The seam exists because the two drivers disagree on exactly three things:
 *
 *  1. How a transaction starts. node-postgres makes you check a connection
 *     out of the pool and send BEGIN / COMMIT / ROLLBACK yourself, and
 *     leaks a connection per failed transition if you forget to release it.
 *     postgres.js does all of that inside `sql.begin()`.
 *  2. What a query resolves to. node-postgres resolves to a `QueryResult`
 *     and the rows are on `.rows`; postgres.js resolves to something that
 *     already *is* the array of rows.
 *  3. Which object represents "inside the transaction". For node-postgres
 *     it is the checked-out client, for postgres.js it is a scoped `sql`.
 *
 * Everything below the seam is driver-agnostic SQL over a
 * "run this parameterised statement, give me rows" function.
 */

import type {
  Adapter,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "@stateledger/core";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";

import type {
  NodePostgresClient,
  NodePostgresPool,
  NodePostgresQueryable,
  PgAdapterOptions,
  PostgresJsQueryable,
  PostgresJsSql,
} from "./types.js";

const DEFAULT_TABLE = "stateledger_transitions";

/** Postgres SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Postgres caps identifiers at 63 bytes (NAMEDATALEN - 1) and silently
 * truncates anything longer, which would leave the adapter writing to a
 * different table than the user asked for. Reject instead.
 */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Run one parameterised statement and resolve with its rows.
 *
 * Both drivers reduce to this. Placeholders are Postgres-numbered
 * (`$1`, `$2`, ...) and `values` is positional.
 */
type QueryFn = (text: string, values: unknown[]) => Promise<unknown[]>;

/**
 * The driver-specific half of the adapter | see the file header for why
 * these three members are exactly the ones that differ.
 */
type Backend<TxHandle> = {
  /**
   * Open a transaction (or join the caller's, when the adapter was built on
   * an existing transaction context) and invoke `fn` with its handle.
   */
  runInTransaction<R>(fn: (tx: TxHandle) => Promise<R>): Promise<R>;
  /** Query function bound to a transaction handle. */
  queryOn(tx: TxHandle): QueryFn;
  /**
   * Query function for reads the contract allows outside a transaction
   * (`readHistory(null, ...)` and `readStateAt(null, ...)`).
   */
  queryOutsideTransaction: QueryFn;
};

/**
 * Raw row shape returned by Postgres before we map to `TransitionRow`.
 *
 * Keys are camelCase because the projection below aliases every column.
 * `sortKey` and `machineVersion` are `INTEGER` columns, so both drivers
 * hand them back as numbers. The wider union is defensive: a user who has
 * migrated those columns to `BIGINT`, or installed a custom type parser,
 * gets a string or a bigint instead and `mapRow` still does the right
 * thing.
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
 * `SELECT *` is not good enough here, for two reasons that both come down
 * to the driver being allowed to reshape rows on their way out:
 *
 * - Every column is aliased to the camelCase name `TransitionRow` uses.
 *   postgres.js accepts a `transform` option, and `postgres({ transform:
 *   postgres.camel })` rewrites the key of every column it returns, so a
 *   bare `SELECT *` would hand back `subject_id` on one connection and
 *   `subjectId` on another and the adapter could not tell which it was
 *   holding. Aliasing pins exactly one shape, and it survives the
 *   transform: that rewrite is snake-to-camel, which is a no-op on a name
 *   with no underscore in it.
 *
 * - `metadata` comes back as `::text` and is parsed in the adapter. The
 *   same camel transform recurses into json and jsonb *values* (it keys
 *   off the column's type OID being 114 or 3802), so a jsonb projection
 *   would arrive with the user's own metadata keys rewritten:
 *   `{ payment_intent: "pi_1" }` silently becoming
 *   `{ paymentIntent: "pi_1" }`. Text is OID 25, so the value is left
 *   exactly as written.
 *
 * Aliases are double-quoted because Postgres down-cases unquoted ones.
 */
const TRANSITION_COLUMNS = `
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
              created_at      AS "createdAt"`;

/** Columns the projection promises and `mapRow` reads. */
const REQUIRED_COLUMNS = [
  "id",
  "machine",
  "subjectId",
  "fromState",
  "toState",
  "sortKey",
  "mostRecent",
  "actorId",
  "actorType",
  "metadata",
  "machineVersion",
  "createdAt",
] as const;

class PgAdapter<TxHandle> implements Adapter<TxHandle> {
  /** Table name, already validated and double-quoted, ready to interpolate. */
  private readonly table: string;
  private readonly locking: "pessimistic" | "optimistic";

  constructor(
    private readonly backend: Backend<TxHandle>,
    options: PgAdapterOptions = {},
  ) {
    this.table = quoteIdentifier(options.tableName ?? DEFAULT_TABLE);
    this.locking = options.locking ?? "pessimistic";
  }

  async withTransaction<R>(fn: (tx: TxHandle) => Promise<R>): Promise<R> {
    return this.backend.runInTransaction(fn);
  }

  async acquireLock(tx: TxHandle, machine: string, subjectId: string): Promise<void> {
    if (this.locking === "optimistic") return;
    const key = `${machine}:${subjectId}`;
    try {
      // `hashtextextended` returns bigint, which `pg_advisory_xact_lock`
      // accepts. The lock auto-releases when the surrounding transaction
      // ends | no explicit unlock is needed (or possible).
      //
      // The `::text` cast is not decoration. postgres.js sends a plain
      // string with an unspecified type OID, and without the cast Postgres
      // has to resolve `hashtextextended(unknown, integer)` on its own.
      // Saying `text` makes the overload unambiguous on both drivers.
      await this.backend.queryOn(tx)(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [key],
      );
    } catch (err) {
      throw rethrowOwn(err, `[${machine}] ${subjectId}: failed to acquire advisory lock`);
    }
  }

  async readCurrent(
    tx: TxHandle,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null> {
    try {
      const rows = await this.backend.queryOn(tx)(
        `SELECT ${TRANSITION_COLUMNS}
             FROM ${this.table}
            WHERE machine = $1
              AND subject_id = $2
              AND most_recent = TRUE
            LIMIT 1`,
        [machine, subjectId],
      );
      const row = rows[0];
      return row === undefined ? null : mapRow(row);
    } catch (err) {
      throw rethrowOwn(err, `[${machine}] ${subjectId}: readCurrent failed`);
    }
  }

  async appendTransition(tx: TxHandle, row: NewTransitionRow): Promise<TransitionRow> {
    const query = this.backend.queryOn(tx);
    try {
      // Flip the previous mostRecent row (no-op for the bootstrap transition).
      await query(
        `UPDATE ${this.table}
              SET most_recent = FALSE
            WHERE machine = $1
              AND subject_id = $2
              AND most_recent = TRUE`,
        [row.machine, row.subjectId],
      );

      // `metadata` is JSON-encoded here because neither driver stringifies
      // a plain object into JSONB on its own: pg would send it as a record
      // literal, and postgres.js needs `sql.json()` to tag it.
      //
      // The parameter is then cast `::text::jsonb` rather than plain
      // `::jsonb`, and that double cast is load-bearing. postgres.js asks
      // the server to describe the statement's parameters and serializes
      // each value with the serializer registered for the OID it gets
      // back. For `$9::jsonb` the server answers "jsonb", whose serializer
      // is `JSON.stringify` | so our already-encoded string was encoded a
      // second time and the column ended up holding the JSON *string*
      // `"{\"source\":\"test\"}"` instead of an object. Reads then handed
      // back a string, which is how this surfaced, but the corruption was
      // on the way in. Casting through `text` makes the server describe
      // `$9` as text (OID 25), whose serializer passes a string through
      // untouched, and the text-to-jsonb cast happens server-side where
      // both drivers behave identically. For node-postgres the extra cast
      // is a no-op: it sends the value as text either way.
      const metadataJson = JSON.stringify(row.metadata ?? {});
      const inserted = await query(
        `INSERT INTO ${this.table} (
              machine, subject_id, from_state, to_state, sort_key, most_recent,
              actor_id, actor_type, metadata, machine_version
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9::text::jsonb, $10
            )
            RETURNING ${TRANSITION_COLUMNS}`,
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
      if (created === undefined) {
        throw new AdapterError(`[${row.machine}] ${row.subjectId}: INSERT returned no rows`);
      }
      return mapRow(created);
    } catch (err) {
      // The partial unique index on (machine, subject_id) WHERE most_recent = TRUE
      // surfaces lost optimistic races as a unique-constraint violation.
      if (isUniqueViolation(err)) {
        throw new OptimisticConcurrencyError(row.machine, row.subjectId);
      }
      throw rethrowOwn(err, `[${row.machine}] ${row.subjectId}: appendTransition failed`);
    }
  }

  async readHistory(
    tx: TxHandle | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]> {
    try {
      const rows = await this.queryFor(tx)(
        `SELECT ${TRANSITION_COLUMNS}
             FROM ${this.table}
            WHERE machine = $1
              AND subject_id = $2
            ORDER BY sort_key ASC`,
        [machine, subjectId],
      );
      return rows.map(mapRow);
    } catch (err) {
      throw rethrowOwn(err, `[${machine}] ${subjectId}: readHistory failed`);
    }
  }

  async readStateAt(
    tx: TxHandle | null,
    machine: string,
    subjectId: string,
    at: Date,
  ): Promise<TransitionRow | null> {
    try {
      // Most recent transition row whose created_at <= cutoff. Order by
      // sort_key DESC (not created_at DESC) for the tiebreak | sortKey is
      // monotonic per (machine, subjectId) and is the canonical ordering
      // used everywhere else in the library.
      const rows = await this.queryFor(tx)(
        `SELECT ${TRANSITION_COLUMNS}
             FROM ${this.table}
            WHERE machine = $1
              AND subject_id = $2
              AND created_at <= $3
            ORDER BY sort_key DESC
            LIMIT 1`,
        [machine, subjectId, at],
      );
      const row = rows[0];
      return row === undefined ? null : mapRow(row);
    } catch (err) {
      throw rethrowOwn(err, `[${machine}] ${subjectId}: readStateAt failed`);
    }
  }

  async updateSubjectState(
    tx: TxHandle,
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

    // Identifiers are quoted (and validated) one by one; the values stay
    // parameterised. `$1` is the new state, so the WHERE values start at `$2`.
    const quotedTable = quoteIdentifier(model);
    const quotedColumn = quoteIdentifier(column);
    const predicates = keys.map((key, index) => `${quoteIdentifier(key)} = $${index + 2}`);
    const values = [newState, ...keys.map((key) => whereObj[key])];

    try {
      await this.backend.queryOn(tx)(
        `UPDATE ${quotedTable}
              SET ${quotedColumn} = $1
            WHERE ${predicates.join(" AND ")}`,
        values,
      );
    } catch (err) {
      throw rethrowOwn(err, `updateSubjectState failed for ${model}.${column}`);
    }
  }

  /**
   * Pick the query function for a read: the caller's transaction when they
   * passed one (strict read-after-write), otherwise a fresh connection.
   */
  private queryFor(tx: TxHandle | null): QueryFn {
    return tx === null ? this.backend.queryOutsideTransaction : this.backend.queryOn(tx);
  }
}

// ---- node-postgres (`pg`) ----

/**
 * Create an adapter bound to a node-postgres client.
 *
 * Pass a `Pool` for typical use | the adapter checks a connection out per
 * transition, sends BEGIN / COMMIT / ROLLBACK itself, and always releases
 * the connection. Pass an already-checked-out `PoolClient` (or a `Client`)
 * to run inside a transaction the caller opened: the adapter will then use
 * that connection as-is and never emit transaction control statements or
 * release it, because its lifetime is not the adapter's to manage.
 */
export function createPgAdapter(
  client: NodePostgresClient,
  options?: PgAdapterOptions,
): Adapter<NodePostgresQueryable> {
  const backend = isPool(client) ? poolBackend(client) : joinedClientBackend(client);
  return new PgAdapter(backend, options);
}

function poolBackend(pool: NodePostgresPool): Backend<NodePostgresQueryable> {
  return {
    async runInTransaction<R>(fn: (tx: NodePostgresQueryable) => Promise<R>): Promise<R> {
      const client = await pool.connect();
      let rollbackError: unknown;
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (failedRollback) {
          // Keep the original failure as the one the caller sees | it is
          // the cause, the rollback failure is a consequence. We do want
          // to remember it so the connection gets destroyed below.
          rollbackError = failedRollback;
        }
        throw err;
      } finally {
        // `release()` MUST run on every path, rollback included, or the
        // pool loses a connection per failed transition and the process
        // eventually deadlocks waiting for a checkout that never comes.
        //
        // Handing the rollback failure to `release()` tells node-postgres
        // to destroy the connection instead of returning it to the pool:
        // if ROLLBACK did not land, the connection may still be inside an
        // aborted transaction and would poison the next borrower.
        client.release(rollbackError);
      }
    },
    queryOn: (tx) => nodePostgresQueryFn(tx),
    queryOutsideTransaction: nodePostgresQueryFn(pool),
  };
}

function joinedClientBackend(client: NodePostgresQueryable): Backend<NodePostgresQueryable> {
  const query = nodePostgresQueryFn(client);
  return {
    // Already inside the caller's transaction | just hand their connection
    // to the callback. No BEGIN, no COMMIT, no release.
    async runInTransaction<R>(fn: (tx: NodePostgresQueryable) => Promise<R>): Promise<R> {
      return fn(client);
    },
    queryOn: () => query,
    queryOutsideTransaction: query,
  };
}

function nodePostgresQueryFn(queryable: NodePostgresQueryable): QueryFn {
  return async (text, values) => {
    const result = await queryable.query(text, values);
    const rows: unknown = result?.rows;
    if (!Array.isArray(rows)) {
      throw new AdapterError(
        "node-postgres query() did not resolve with `{ rows }`. " +
          "Is this a `pg` Pool, Client, or PoolClient?",
      );
    }
    return rows;
  };
}

/**
 * Tell a `Pool` apart from a single connection.
 *
 * `connect()` is not a discriminator: `Pool.connect()` checks a connection
 * out, and `Client.connect()` opens the socket, so both have it. The pool
 * counters only exist on the pool, so `totalCount` is what we key on.
 */
function isPool(client: NodePostgresClient): client is NodePostgresPool {
  const candidate = client as Partial<NodePostgresPool>;
  return typeof candidate.connect === "function" && typeof candidate.totalCount === "number";
}

// ---- postgres.js (`postgres`) ----

/**
 * Create an adapter bound to a postgres.js instance.
 *
 * Pass the top-level `sql` for typical use | the adapter calls
 * `sql.begin()`, which reserves a connection, sends BEGIN, and commits or
 * rolls back on its own. There is nothing to release.
 *
 * Pass a transaction `sql` (the one postgres.js hands your `sql.begin`
 * callback) to run inside a transaction the caller opened. postgres.js
 * turns the adapter's nested `begin()` into a savepoint on that same
 * connection, so a failed transition rolls back to the savepoint without
 * killing the caller's transaction.
 */
export function createPostgresJsAdapter(
  sql: PostgresJsSql,
  options?: PgAdapterOptions,
): Adapter<PostgresJsQueryable> {
  const backend: Backend<PostgresJsQueryable> = {
    async runInTransaction<R>(fn: (tx: PostgresJsQueryable) => Promise<R>): Promise<R> {
      // postgres.js resolves `begin` through its `UnwrapPromiseArray`
      // conditional: when the callback resolves with an array, its elements
      // are awaited too. For every non-array result | which is all the
      // library ever returns from a transition | the value passes straight
      // through, so narrowing back to `R` here is sound.
      const result: unknown = await sql.begin((tx: PostgresJsQueryable) => fn(tx));
      return result as R;
    },
    queryOn: (tx) => postgresJsQueryFn(tx),
    queryOutsideTransaction: postgresJsQueryFn(sql),
  };
  return new PgAdapter(backend, options);
}

function postgresJsQueryFn(queryable: PostgresJsQueryable): QueryFn {
  return async (text, values) => {
    // The asymmetry with node-postgres: `unsafe()` resolves with the rows
    // themselves (a `RowList`, which is a real array carrying extra
    // properties like `.count`), not with a result object wrapping them.
    const rows: unknown = await queryable.unsafe(text, values);
    if (!Array.isArray(rows)) {
      throw new AdapterError(
        "postgres.js unsafe() did not resolve with an array of rows. " +
          "Is this a `postgres` instance (or the `sql` from `sql.begin`)?",
      );
    }
    return rows;
  };
}

// ---- internal helpers ----

/**
 * Detect "unique constraint violation" from the Postgres driver error.
 *
 * Both drivers put SQLSTATE `23505` directly on `.code`: node-postgres on
 * its `DatabaseError`, postgres.js on its `PostgresError` (it copies every
 * field of the server's error response onto the instance). The nested
 * lookups cover callers who wrap driver errors on the way out | a
 * connection helper that re-throws with `{ cause }`, or an ORM that keeps
 * the driver error on `.original`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown } | null;
    original?: { code?: unknown } | null;
  };
  if (e.code === UNIQUE_VIOLATION) return true;
  if (
    e.cause &&
    typeof e.cause === "object" &&
    (e.cause as { code?: unknown }).code === UNIQUE_VIOLATION
  ) {
    return true;
  }
  if (
    e.original &&
    typeof e.original === "object" &&
    (e.original as { code?: unknown }).code === UNIQUE_VIOLATION
  ) {
    return true;
  }
  return false;
}

/**
 * Wrap a driver error in `AdapterError`, but let our own error types
 * through untouched so callers can keep matching on them (double-wrapping
 * an `OptimisticConcurrencyError` would break every retry loop built on
 * `instanceof`).
 */
function rethrowOwn(err: unknown, message: string): Error {
  if (err instanceof AdapterError || err instanceof OptimisticConcurrencyError) {
    return err;
  }
  return new AdapterError(message, { cause: err });
}

function mapRow(row: unknown): TransitionRow {
  const raw = asRawRow(row);
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
 * The column is `NOT NULL DEFAULT '{}'::jsonb`, so in practice this is
 * always a JSON object literal. It is still validated: a row written by
 * something other than this adapter could hold a scalar or an array, and
 * handing that back as `Record<string, unknown>` would be a lie the rest
 * of the library trips over later.
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
      `metadata column must hold a JSON object, got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Check that a driver row actually carries the columns the projection
 * asked for, and say what would explain it if not.
 *
 * With every column aliased this should be unreachable: the aliases are
 * the names the mapping reads. It stays as a tripwire because a driver
 * that rewrites result keys can still defeat them | postgres.js's
 * `transform: postgres.pascal` turns `id` into `Id` and `subjectId` into
 * `SubjectId` | and a row of `undefined`s that only breaks three layers
 * up is a bad way to find that out.
 *
 * `postgres.camel` and `postgres.kebab` both survive the projection, for
 * the same reason: one maps snake_case to camelCase and the other maps
 * `_` to `-`, and no alias here contains an underscore. Only a transform
 * that touches a name with no underscore in it, which means pascal,
 * reaches this tripwire. Verified in
 * `test/edge-cases.postgres-js.integration.ts`.
 */
function asRawRow(row: unknown): RawTransitionRow {
  if (!row || typeof row !== "object") {
    throw new AdapterError(
      `expected a row object from the driver, got ${row === null ? "null" : typeof row}`,
    );
  }
  for (const column of REQUIRED_COLUMNS) {
    if (!(column in row)) {
      throw new AdapterError(
        `transition row is missing the "${column}" column, which the adapter's own ` +
          "projection aliases it to. A driver-level result-key rename (for example " +
          "postgres.js's `transform: postgres.pascal`) is not supported on the connection " +
          "stateledger uses.",
      );
    }
  }
  return row as RawTransitionRow;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/**
 * Validate an identifier and return it double-quoted, ready to interpolate.
 *
 * Drizzle got this for free from `sql.identifier()`; with a raw driver
 * there is no such helper, and no driver can bind an identifier as a
 * parameter | `SELECT * FROM $1` is not valid SQL. So the table name has
 * to reach the query as text, which makes this function the only thing
 * standing between a configurable `tableName` and a SQL injection hole.
 *
 * It is deliberately a whitelist, not an escape: only the characters a
 * plain unquoted Postgres identifier may contain get through, which leaves
 * nothing to escape (a double quote cannot appear, so the quoting cannot be
 * broken out of). The quotes still go on, for two reasons: they preserve
 * case for a table created as `"MyTable"`, and they let a name that
 * collides with a reserved word still work.
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
  // The pattern above admits ASCII only, so length is byte length.
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new AdapterError(
      `SQL identifier too long: ${JSON.stringify(name)} is ${name.length} characters, ` +
        `Postgres truncates past ${MAX_IDENTIFIER_LENGTH}`,
    );
  }
  return `"${name}"`;
}
