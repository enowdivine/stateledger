/**
 * Prisma adapter implementation for stateledger.
 *
 * All persistence is done through Prisma's raw-SQL escape hatches
 * (`$queryRawUnsafe` / `$executeRawUnsafe`). The adapter does NOT depend
 * on the user having added a `StateledgerTransition` model to their
 * schema.prisma — only the underlying `stateledger_transitions` table.
 *
 * We also deliberately don't import types from `@prisma/client` (those
 * only exist after `prisma generate` runs against a user schema). The
 * structural types in `./types.ts` are what we actually call.
 */

import type {
  Adapter,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "@stateledger/core";
import { AdapterError, OptimisticConcurrencyError } from "@stateledger/core";

import type {
  PrismaAdapterOptions,
  PrismaRawCalls,
  PrismaTransactionalClient,
  PrismaTx,
} from "./types.js";

const DEFAULT_TABLE = "stateledger_transitions";

/**
 * Internal: raw shape we get back from Postgres before mapping to the
 * library's `TransitionRow`.
 */
type RawTransitionRow = {
  id: string;
  machine: string;
  subject_id: string;
  from_state: string | null;
  to_state: string;
  sort_key: number | bigint;
  most_recent: boolean;
  actor_id: string | null;
  actor_type: string | null;
  metadata: Record<string, unknown> | null;
  machine_version: number | bigint;
  created_at: Date | string;
};

class PrismaAdapter implements Adapter<PrismaRawCalls> {
  private readonly tableName: string;
  private readonly locking: "pessimistic" | "optimistic";

  constructor(
    /**
     * The root Prisma client. Held for `withTransaction` (when it's a
     * top-level PrismaClient) and for `readHistory(null, …)` (when no tx
     * was provided).
     */
    private readonly root: PrismaTx,
    options: PrismaAdapterOptions = {},
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE;
    this.locking = options.locking ?? "pessimistic";
    assertValidIdentifier(this.tableName);
  }

  async withTransaction<R>(fn: (tx: PrismaRawCalls) => Promise<R>): Promise<R> {
    if (hasTransactionMethod(this.root)) {
      return this.root.$transaction((tx: PrismaRawCalls) => fn(tx));
    }
    // Already inside a transaction client — just call the fn with it.
    return fn(this.root);
  }

  async acquireLock(
    tx: PrismaRawCalls,
    machine: string,
    subjectId: string,
  ): Promise<void> {
    if (this.locking === "optimistic") return;
    const key = `${machine}:${subjectId}`;
    try {
      // hashtextextended returns bigint, which pg_advisory_xact_lock accepts.
      // The lock auto-releases when the surrounding transaction ends.
      //
      // We use $executeRawUnsafe (not $queryRawUnsafe) because pg_advisory_xact_lock
      // returns SQL `void`, which Prisma's $queryRaw path can't deserialize.
      // $executeRawUnsafe runs the statement without trying to materialize columns.
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        key,
      );
    } catch (err) {
      throw new AdapterError(
        `[${machine}] ${subjectId}: failed to acquire advisory lock`,
        { cause: err },
      );
    }
  }

  async readCurrent(
    tx: PrismaRawCalls,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null> {
    try {
      const rows = await tx.$queryRawUnsafe<RawTransitionRow[]>(
        `SELECT * FROM "${this.tableName}"
           WHERE machine = $1 AND subject_id = $2 AND most_recent = TRUE
           LIMIT 1`,
        machine,
        subjectId,
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
    tx: PrismaRawCalls,
    row: NewTransitionRow,
  ): Promise<TransitionRow> {
    try {
      // Flip the previous mostRecent row (no-op for the bootstrap transition).
      await tx.$executeRawUnsafe(
        `UPDATE "${this.tableName}"
            SET most_recent = FALSE
          WHERE machine = $1 AND subject_id = $2 AND most_recent = TRUE`,
        row.machine,
        row.subjectId,
      );

      // Insert the new row and return it.
      const inserted = await tx.$queryRawUnsafe<RawTransitionRow[]>(
        `INSERT INTO "${this.tableName}" (
            machine, subject_id, from_state, to_state, sort_key, most_recent,
            actor_id, actor_type, metadata, machine_version
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9::jsonb, $10
          )
          RETURNING *`,
        row.machine,
        row.subjectId,
        row.fromState,
        row.toState,
        row.sortKey,
        row.mostRecent,
        row.actorId,
        row.actorType,
        JSON.stringify(row.metadata ?? {}),
        row.machineVersion,
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
    tx: PrismaRawCalls | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]> {
    const client = tx ?? this.root;
    try {
      const rows = await client.$queryRawUnsafe<RawTransitionRow[]>(
        `SELECT * FROM "${this.tableName}"
           WHERE machine = $1 AND subject_id = $2
           ORDER BY sort_key ASC`,
        machine,
        subjectId,
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
    tx: PrismaRawCalls | null,
    machine: string,
    subjectId: string,
    at: Date,
  ): Promise<TransitionRow | null> {
    const client = tx ?? this.root;
    try {
      // Most recent transition row whose created_at <= cutoff. We order by
      // sort_key DESC rather than created_at DESC for the tiebreak — sortKey
      // is monotonic per (machine, subjectId) and is the canonical ordering
      // we trust everywhere else in the library.
      const rows = await client.$queryRawUnsafe<RawTransitionRow[]>(
        `SELECT * FROM "${this.tableName}"
           WHERE machine = $1 AND subject_id = $2 AND created_at <= $3
           ORDER BY sort_key DESC
           LIMIT 1`,
        machine,
        subjectId,
        at,
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
    tx: PrismaRawCalls,
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

    // $1 is newState; $2..$N are the where values in declared order.
    const whereSql = keys.map((k, i) => `"${k}" = $${i + 2}`).join(" AND ");
    const values = keys.map((k) => whereObj[k]);

    try {
      await tx.$executeRawUnsafe(
        `UPDATE "${model}" SET "${column}" = $1 WHERE ${whereSql}`,
        newState,
        ...values,
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
 * Create an adapter bound to a Prisma client.
 *
 * Pass a top-level `PrismaClient` for typical use — the adapter will open
 * its own transactions. Pass a `Prisma.TransactionClient` to join an
 * existing transaction the caller opened higher up the stack (e.g. when
 * the transition is one step inside a larger business transaction).
 */
export function createPrismaAdapter(
  client: PrismaTx,
  options?: PrismaAdapterOptions,
): Adapter<PrismaRawCalls> {
  return new PrismaAdapter(client, options);
}

// ---- internal helpers ----

function hasTransactionMethod(client: PrismaTx): client is PrismaTransactionalClient {
  return typeof (client as PrismaTransactionalClient).$transaction === "function";
}

/**
 * Detect "unique constraint violation" across the ways Prisma surfaces it
 * to raw queries:
 *
 *   - `PrismaClientKnownRequestError` with code `"P2002"` (mapped form)
 *   - A generic error with Postgres SQLSTATE `"23505"` on `.code` or
 *     `.meta.code` (passthrough form on $queryRawUnsafe / $executeRawUnsafe)
 *
 * Avoids `instanceof Prisma.PrismaClientKnownRequestError` because that
 * type only exists in the generated client — see types.ts header.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } | null };
  if (e.code === "P2002") return true;
  if (e.code === "23505") return true;
  if (e.meta && typeof e.meta === "object" && (e.meta as { code?: unknown }).code === "23505") {
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
 * The Prisma adapter takes the table name and (via `subjectStateColumn`)
 * model/column/identifier names as user-supplied strings. Those land in
 * raw SQL, so they MUST be restricted to a SQL-identifier-safe alphabet.
 */
function assertValidIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdapterError(
      `invalid SQL identifier: ${JSON.stringify(name)} (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
    );
  }
}
