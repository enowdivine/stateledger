/**
 * Recommended Postgres schema for the transitions table.
 *
 * Exported in two shapes:
 *
 * - `STATELEDGER_SCHEMA_STATEMENTS`: an array of individual DDL statements.
 *   Use this when you're applying the schema programmatically through a
 *   driver that only accepts one statement at a time — notably Prisma's
 *   `$executeRawUnsafe`, which uses prepared statements and rejects
 *   multi-statement scripts. Loop the array and execute each.
 *
 * - `STATELEDGER_SCHEMA_SQL`: the same statements concatenated into one
 *   string. Use this when pasting into a Prisma migration's `migration.sql`
 *   or any other tool that accepts a multi-statement script.
 *
 * Why we ship this as raw SQL rather than a Prisma model:
 *   - Prisma's schema language doesn't express the partial unique index on
 *     `(machine, subject_id) WHERE most_recent = true` that's load-bearing
 *     for our concurrency guarantees.
 *   - Keeps the adapter ORM-agnostic at the storage level — the same SQL
 *     works for the Drizzle and TypeORM adapters when they ship.
 */

export const STATELEDGER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "stateledger_transitions" (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    machine          TEXT         NOT NULL,
    subject_id       TEXT         NOT NULL,
    from_state       TEXT,
    to_state         TEXT         NOT NULL,
    sort_key         INTEGER      NOT NULL,
    most_recent      BOOLEAN      NOT NULL DEFAULT TRUE,
    actor_id         TEXT,
    actor_type       TEXT,
    metadata         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    machine_version  INTEGER      NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  // Deterministic ordering for history reads + the (machine, subject) lookup.
  `CREATE UNIQUE INDEX IF NOT EXISTS "stateledger_transitions_subject_sort_key"
    ON "stateledger_transitions" (machine, subject_id, sort_key)`,

  // Partial unique index: exactly one mostRecent row per (machine, subject).
  // This is the optimistic-concurrency safety net + a hard correctness invariant.
  `CREATE UNIQUE INDEX IF NOT EXISTS "stateledger_transitions_one_most_recent"
    ON "stateledger_transitions" (machine, subject_id)
    WHERE most_recent = TRUE`,

  // "Recent transitions for this subject, newest first" — covers history pagination.
  `CREATE INDEX IF NOT EXISTS "stateledger_transitions_history"
    ON "stateledger_transitions" (machine, subject_id, sort_key DESC)`,
];

export const STATELEDGER_SCHEMA_SQL: string = STATELEDGER_SCHEMA_STATEMENTS.join(";\n\n") + ";";
