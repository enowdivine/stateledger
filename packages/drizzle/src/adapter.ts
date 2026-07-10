/**
 * Drizzle adapter implementation for stateledger.
 *
 * All persistence goes through Drizzle's `execute()` + `sql`` `` template.
 * The adapter doesn't require the user to have added a `stateledger`
 * schema definition to their `drizzle` schema file — only the underlying
 * `stateledger_transitions` table (see `./schema-sql.ts`).
 *
 * Structural typing means any Drizzle Postgres client (node-postgres,
 * postgres.js, neon-serverless) satisfies the `DrizzleDb` contract via
 * duck typing.
 */

import type {
  Adapter,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "@stateledger/core";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";
import { sql } from "drizzle-orm";

import type {
  DrizzleAdapterOptions,
  DrizzleDb,
  DrizzleExecutor,
  DrizzleTransactionalClient,
} from "./types.js";

const DEFAULT_TABLE = "stateledger_transitions";

/**
 * Raw row shape returned by Postgres before we map to `TransitionRow`.
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

class DrizzleAdapter implements Adapter<DrizzleExecutor> {
  private readonly tableName: string;
  private readonly locking: "pessimistic" | "optimistic";

  constructor(
    private readonly root: DrizzleDb,
    options: DrizzleAdapterOptions = {},
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE;
    this.locking = options.locking ?? "pessimistic";
    assertValidIdentifier(this.tableName);
  }

  async withTransaction<R>(fn: (tx: DrizzleExecutor) => Promise<R>): Promise<R> {
    if (hasTransactionMethod(this.root)) {
      return this.root.transaction((tx: DrizzleExecutor) => fn(tx));
    }
    // Already inside a transaction context — just call the fn with it.
    return fn(this.root);
  }

  async acquireLock(
    tx: DrizzleExecutor,
    machine: string,
    subjectId: string,
  ): Promise<void> {
    if (this.locking === "optimistic") return;
    const key = `${machine}:${subjectId}`;
    try {
      // `hashtextextended` returns bigint, which `pg_advisory_xact_lock`
      // accepts. The lock auto-releases when the surrounding transaction
      // ends — no explicit unlock is needed (or possible).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: failed to acquire advisory lock`,
        { cause: err },
      );
    }
  }

  async readCurrent(
    tx: DrizzleExecutor,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null> {
    try {
      const result = await tx.execute<unknown>(
        sql`SELECT * FROM ${sql.identifier(this.tableName)}
              WHERE machine = ${machine}
                AND subject_id = ${subjectId}
                AND most_recent = TRUE
              LIMIT 1`,
      );
      const rows = extractRows<RawTransitionRow>(result);
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
    tx: DrizzleExecutor,
    row: NewTransitionRow,
  ): Promise<TransitionRow> {
    try {
      // Flip the previous mostRecent row (no-op for the bootstrap transition).
      await tx.execute(
        sql`UPDATE ${sql.identifier(this.tableName)}
               SET most_recent = FALSE
             WHERE machine = ${row.machine}
               AND subject_id = ${row.subjectId}
               AND most_recent = TRUE`,
      );

      // Insert the new row and return it. `metadata` is JSON-encoded here
      // because Drizzle's raw execute doesn't stringify objects for JSONB.
      const metadataJson = JSON.stringify(row.metadata ?? {});
      const result = await tx.execute<unknown>(
        sql`INSERT INTO ${sql.identifier(this.tableName)} (
              machine, subject_id, from_state, to_state, sort_key, most_recent,
              actor_id, actor_type, metadata, machine_version
            ) VALUES (
              ${row.machine}, ${row.subjectId}, ${row.fromState}, ${row.toState},
              ${row.sortKey}, ${row.mostRecent},
              ${row.actorId}, ${row.actorType}, ${metadataJson}::jsonb, ${row.machineVersion}
            )
            RETURNING *`,
      );

      const rows = extractRows<RawTransitionRow>(result);
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
    tx: DrizzleExecutor | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]> {
    const client = tx ?? this.root;
    try {
      const result = await client.execute<unknown>(
        sql`SELECT * FROM ${sql.identifier(this.tableName)}
              WHERE machine = ${machine}
                AND subject_id = ${subjectId}
              ORDER BY sort_key ASC`,
      );
      return extractRows<RawTransitionRow>(result).map(mapRow);
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: readHistory failed`,
        { cause: err },
      );
    }
  }

  async readStateAt(
    tx: DrizzleExecutor | null,
    machine: string,
    subjectId: string,
    at: Date,
  ): Promise<TransitionRow | null> {
    const client = tx ?? this.root;
    try {
      // Most recent transition row whose created_at <= cutoff. Order by
      // sort_key DESC (not created_at DESC) for the tiebreak — sortKey is
      // monotonic per (machine, subjectId) and is the canonical ordering
      // used everywhere else in the library.
      const result = await client.execute<unknown>(
        sql`SELECT * FROM ${sql.identifier(this.tableName)}
              WHERE machine = ${machine}
                AND subject_id = ${subjectId}
                AND created_at <= ${at}
              ORDER BY sort_key DESC
              LIMIT 1`,
      );
      const rows = extractRows<RawTransitionRow>(result);
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
    tx: DrizzleExecutor,
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

    // Build the parameterized WHERE fragment via sql.join so each column
    // stays parameterized (no string concatenation of user values into
    // raw SQL).
    const whereFragments = keys.map(
      (k) => sql`${sql.identifier(k)} = ${whereObj[k]}`,
    );
    const whereSql = sql.join(whereFragments, sql` AND `);

    try {
      await tx.execute(
        sql`UPDATE ${sql.identifier(model)}
               SET ${sql.identifier(column)} = ${newState}
             WHERE ${whereSql}`,
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
 * Create an adapter bound to a Drizzle client.
 *
 * Pass a top-level Drizzle client for typical use — the adapter will open
 * its own transactions via `db.transaction()`. Pass a Drizzle transaction
 * context to join an existing transaction the caller opened higher up
 * the stack.
 */
export function createDrizzleAdapter(
  client: DrizzleDb,
  options?: DrizzleAdapterOptions,
): Adapter<DrizzleExecutor> {
  return new DrizzleAdapter(client, options);
}

// ---- internal helpers ----

function hasTransactionMethod(client: DrizzleDb): client is DrizzleTransactionalClient {
  return typeof (client as DrizzleTransactionalClient).transaction === "function";
}

/**
 * Normalize `execute()` output across Drizzle's Postgres drivers.
 *
 * - `drizzle-orm/node-postgres`: returns pg's `QueryResult` — `{ rows: T[] }`.
 * - `drizzle-orm/postgres-js`: returns a `RowList<T>` that IS a `T[]` (with
 *   extra properties like `.count`).
 * - `drizzle-orm/neon-serverless`: also `{ rows: T[] }` (uses pg protocol).
 */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new AdapterError(
    "Unexpected execute() result shape: expected an array or an object with `.rows`. " +
      "Is this a Drizzle Postgres client?",
  );
}

/**
 * Detect "unique constraint violation" from the Postgres driver error.
 * All Postgres drivers surface SQLSTATE `23505`; some (pg) put it on
 * `.code`, some (postgres.js) on `.code` too, node-postgres nests it
 * further in some setups. Check every plausible location.
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
 * `sql.identifier()` already quotes identifiers to make injection hard,
 * but we still validate at the boundary so misconfigured hints fail loud
 * and early instead of at query time.
 */
function assertValidIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
}
