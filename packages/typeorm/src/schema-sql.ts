/**
 * Recommended Postgres schema for the transitions table.
 *
 * Exported in two shapes:
 *
 * - `STATELEDGER_SCHEMA_STATEMENTS`: an array of individual DDL statements.
 *   Use this when applying the schema through a driver that runs one
 *   statement at a time | including `manager.query()` / `queryRunner.query()`,
 *   which send a single statement each.
 * - `STATELEDGER_SCHEMA_SQL`: the same statements concatenated into one
 *   multi-statement script. Use this when pasting into a TypeORM migration's
 *   `up()` or any tool that accepts multi-statement input.
 *
 * The SQL here is identical to what `@stateledger/prisma` and
 * `@stateledger/drizzle` ship. It's duplicated intentionally: the adapters
 * have separate release cadences, and the SQL is ORM-agnostic Postgres DDL
 * that shouldn't change often. If it needs to change, every adapter must be
 * bumped in lockstep.
 *
 * Worth knowing for TypeORM specifically: this table is NOT modelled as an
 * entity class, so `synchronize: true` neither creates it nor drops it, and
 * `typeorm migration:generate` will never emit it. It is yours to apply, via
 * a migration that runs this DDL or via your usual schema tooling. See the
 * README.
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

  // "Recent transitions for this subject, newest first" | covers history pagination.
  `CREATE INDEX IF NOT EXISTS "stateledger_transitions_history"
    ON "stateledger_transitions" (machine, subject_id, sort_key DESC)`,
];

export const STATELEDGER_SCHEMA_SQL: string = STATELEDGER_SCHEMA_STATEMENTS.join(";\n\n") + ";";
