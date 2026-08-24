/**
 * Recommended Postgres schema for the outbox table.
 *
 * Exported in two shapes:
 *
 * - `OUTBOX_SCHEMA_STATEMENTS`: an array of individual DDL statements.
 *   Use this when applying the schema through a driver that only accepts
 *   one statement at a time — notably Prisma's `$executeRawUnsafe`, which
 *   uses prepared statements and rejects multi-statement scripts.
 *
 * - `OUTBOX_SCHEMA_SQL`: the same statements concatenated into one string.
 *   Use this when pasting into a Prisma migration's `migration.sql` or any
 *   other tool that accepts a multi-statement script.
 *
 * Status column values:
 *   - `pending`   — waiting for a worker to claim
 *   - `processing` — a worker is currently dispatching (see `worker_id` / `claimed_at`)
 *   - `delivered` — successful terminal state
 *   - `failed`    — exceeded `maxAttempts`; dead letter, kept for manual review
 */

export const OUTBOX_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "stateledger_outbox" (
    id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           TEXT          NOT NULL,
    payload        JSONB         NOT NULL DEFAULT '{}'::jsonb,
    region         TEXT,
    status         TEXT          NOT NULL DEFAULT 'pending',
    attempts       INTEGER       NOT NULL DEFAULT 0,
    last_error     TEXT,
    available_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    claimed_at     TIMESTAMPTZ,
    worker_id      TEXT,
    delivered_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT "stateledger_outbox_status_valid"
      CHECK (status IN ('pending', 'processing', 'delivered', 'failed'))
  )`,

  // Poll index: the hot path is "give me the next pending row for my region
  // that's eligible now." Partial index on status = 'pending' keeps it small
  // and ignores terminal rows the worker never reads again.
  `CREATE INDEX IF NOT EXISTS "stateledger_outbox_poll"
    ON "stateledger_outbox" (region, available_at)
    WHERE status = 'pending'`,

  // Diagnostics + dead-letter browsing.
  `CREATE INDEX IF NOT EXISTS "stateledger_outbox_status_created"
    ON "stateledger_outbox" (status, created_at DESC)`,

  // Stuck-row detection: workers that claimed a row but crashed leave
  // `status = 'processing'` with an old `claimed_at`. This index makes
  // reclaim queries fast without table scans.
  `CREATE INDEX IF NOT EXISTS "stateledger_outbox_processing_claimed_at"
    ON "stateledger_outbox" (claimed_at)
    WHERE status = 'processing'`,
];

export const OUTBOX_SCHEMA_SQL: string =
  OUTBOX_SCHEMA_STATEMENTS.join(";\n\n") + ";";
