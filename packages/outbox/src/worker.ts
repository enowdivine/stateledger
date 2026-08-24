/**
 * The outbox worker — a poll loop that claims rows atomically, dispatches
 * them through the user's handler registry, and either marks them delivered
 * or reschedules with backoff (dead-lettering after `maxAttempts`).
 *
 * # Concurrency model
 *
 * One worker instance = one Node process (or one script). To scale, run
 * multiple workers pointing at the same DB — `FOR UPDATE SKIP LOCKED` in
 * the claim query guarantees each row is dispatched by at most one worker
 * at a time even under contention. That's the standard Postgres queue
 * primitive; we don't try to be cleverer.
 *
 * # At-least-once, not exactly-once
 *
 * If a worker crashes between "call Stripe" and "mark delivered," the row
 * is left in `processing`. On the next boot, a stuck-row reclaim query
 * (see {@link reclaimStuckRows}) puts it back to `pending`, and it will be
 * re-dispatched. Handlers MUST be idempotent — use idempotency keys on the
 * receiving side (Stripe supports it; email providers vary).
 *
 * # Backoff
 *
 * On failure, the row's `attempts` is incremented and `available_at` is set
 * to `now() + backoffMs(attempts)`. The next poll skips it until the time
 * arrives. Default backoff is exponential 1s / 2s / 4s / 8s / 16s (capped
 * at 5 minutes) — pass `backoffMs` in config to override.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { OutboxAdapterError, UnknownKindError } from "./errors.js";
import { mapRow } from "./enqueue.js";
import type {
  HandlerRegistry,
  OutboxRecord,
  OutboxTx,
  WorkerConfig,
  WorkerEvent,
  WorkerHandle,
} from "./types.js";

const TABLE = "stateledger_outbox";

/** After this long in `processing` a row is assumed abandoned. */
const STUCK_AFTER_MS = 5 * 60 * 1000; // 5 minutes

/** Cap on the exponential-backoff default. Prevents multi-hour delays. */
const DEFAULT_BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Default backoff schedule | exponential with a 5-minute cap. `attempt` is
 * 1-based so the first failure waits ~1s, second ~2s, etc.
 */
export function defaultBackoffMs(attempt: number): number {
  const ms = 1000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(ms, DEFAULT_BACKOFF_CAP_MS);
}

/**
 * Build a worker instance. Call `.start()` to begin polling. The returned
 * handle exposes `.stop()` for graceful shutdown — awaits the in-flight
 * dispatch (if any) before resolving.
 */
export function createWorker(config: WorkerConfig): WorkerHandle {
  const {
    client,
    handlers,
    region,
    pollIntervalMs = 500,
    maxAttempts = 5,
    backoffMs = defaultBackoffMs,
    onEvent,
  } = config;
  const workerId = config.workerId ?? defaultWorkerId();

  // Runtime state kept in closure — the returned handle only exposes the
  // narrow public API. No class needed for something this small.
  let running = false;
  let stopRequested = false;
  // Resolves when the current tick's dispatch (if any) settles.
  let inFlight: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const emit = (event: WorkerEvent) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // Observer errors are the observer's problem; never break the loop.
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (stopRequested) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopRequested) return;
    try {
      // Best-effort: reclaim stuck rows before claiming. Cheap query when
      // there are none (partial index makes it fast).
      await reclaimStuckRows(client, workerId);

      const claimed = await claimNext(client, workerId, region);
      if (!claimed) {
        // Queue is empty — wait a full poll interval before checking again.
        scheduleNext(pollIntervalMs);
        return;
      }

      emit({ type: "claimed", record: claimed });

      inFlight = dispatchOne(client, claimed, handlers, maxAttempts, backoffMs, emit);
      await inFlight;
      inFlight = null;

      // We just processed a row; try again immediately in case there are more.
      scheduleNext(0);
    } catch (err) {
      emit({ type: "worker-error", error: err });
      // Back off a full interval on unexpected worker-level errors so we
      // don't hot-loop against a broken DB.
      scheduleNext(pollIntervalMs);
    }
  };

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      stopRequested = false;
      scheduleNext(0);
    },
    async stop() {
      stopRequested = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Wait for the currently-dispatching row (if any) to finish so we don't
      // leave `status = 'processing'` behind on the way out.
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already surfaced through emit(); nothing new to do here.
        }
      }
      running = false;
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Internal helpers                                                        */
/* ─────────────────────────────────────────────────────────────────────── */

type RawOutboxRow = Parameters<typeof mapRow>[0];

/**
 * Atomically claim the next eligible row. Returns `null` when the queue is
 * empty (no pending rows for this region whose `available_at <= now()`).
 *
 * The UPDATE uses a sub-SELECT with `FOR UPDATE SKIP LOCKED` so multiple
 * worker processes racing this query each grab a different row (or, if
 * fewer rows than workers, some get `null` and back off).
 */
async function claimNext(
  client: OutboxTx,
  workerId: string,
  region: string | undefined,
): Promise<OutboxRecord | null> {
  try {
    const rows = await client.$queryRawUnsafe<RawOutboxRow[]>(
      `UPDATE "${TABLE}"
          SET status       = 'processing',
              worker_id    = $1,
              claimed_at   = NOW(),
              attempts     = attempts + 1
        WHERE id = (
          SELECT id FROM "${TABLE}"
           WHERE status = 'pending'
             AND ($2::text IS NULL OR region = $2 OR region IS NULL)
             AND available_at <= NOW()
           ORDER BY available_at ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
      workerId,
      region ?? null,
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    throw new OutboxAdapterError("claimNext failed", { cause: err });
  }
}

/**
 * Reset rows that were claimed by some worker but never terminated (crash
 * mid-dispatch). Anything in `processing` older than `STUCK_AFTER_MS` is
 * put back to `pending` so a live worker can pick it up.
 *
 * Idempotent + cheap — the partial index on `claimed_at WHERE status =
 * 'processing'` keeps it O(stuck rows), which is almost always zero.
 */
async function reclaimStuckRows(client: OutboxTx, workerId: string): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `UPDATE "${TABLE}"
          SET status     = 'pending',
              worker_id  = NULL,
              claimed_at = NULL,
              last_error = COALESCE(last_error, '') ||
                           ' [reclaimed by ' || $1 || ' at ' || NOW()::text || ']'
        WHERE status = 'processing'
          AND claimed_at IS NOT NULL
          AND claimed_at < NOW() - INTERVAL '${STUCK_AFTER_MS} milliseconds'`,
      workerId,
    );
  } catch (err) {
    // Reclaim is best-effort. Log via the worker's onEvent hook (through
    // the tick's try/catch), but don't fail the tick over it.
    throw new OutboxAdapterError("reclaimStuckRows failed", { cause: err });
  }
}

/**
 * Run the registered handler for a claimed row. On success mark delivered;
 * on failure, reschedule (with backoff) or dead-letter based on attempts.
 *
 * Never rethrows — errors flow through `emit`. Rethrowing would cascade
 * into the tick's catch and cause an extra `worker-error` event on top of
 * the specific per-row event we already emitted.
 */
async function dispatchOne(
  client: OutboxTx,
  record: OutboxRecord,
  handlers: HandlerRegistry,
  maxAttempts: number,
  backoffMs: (attempt: number) => number,
  emit: (event: WorkerEvent) => void,
): Promise<void> {
  const handler = handlers[record.kind];
  if (!handler) {
    // No handler for this kind — dead-letter immediately. Retrying won't
    // help; the code hasn't been deployed yet or the kind is a typo.
    const err = new UnknownKindError(record.kind, record.id);
    await markFailed(client, record.id, err.message);
    emit({ type: "unknown-kind", record });
    return;
  }

  const startedAt = Date.now();
  try {
    await handler(record.payload, {
      kind: record.kind,
      region: record.region,
      attempts: record.attempts,
      record,
    });
    await markDelivered(client, record.id);
    emit({
      type: "delivered",
      record,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (record.attempts >= maxAttempts) {
      await markFailed(client, record.id, message);
      emit({ type: "dead-lettered", record, error: err });
    } else {
      const nextAvailableAt = new Date(Date.now() + backoffMs(record.attempts));
      await rescheduleFailed(client, record.id, message, nextAvailableAt);
      emit({ type: "rescheduled", record, error: err, nextAvailableAt });
    }
  }
}

async function markDelivered(client: OutboxTx, id: string): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `UPDATE "${TABLE}"
          SET status       = 'delivered',
              delivered_at = NOW(),
              claimed_at   = NULL,
              worker_id    = NULL,
              last_error   = NULL
        WHERE id = $1`,
      id,
    );
  } catch (err) {
    throw new OutboxAdapterError(`markDelivered(${id}) failed`, { cause: err });
  }
}

async function rescheduleFailed(
  client: OutboxTx,
  id: string,
  errorMsg: string,
  nextAvailableAt: Date,
): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `UPDATE "${TABLE}"
          SET status       = 'pending',
              last_error   = $2,
              available_at = $3,
              claimed_at   = NULL,
              worker_id    = NULL
        WHERE id = $1`,
      id,
      errorMsg,
      nextAvailableAt,
    );
  } catch (err) {
    throw new OutboxAdapterError(`rescheduleFailed(${id}) failed`, { cause: err });
  }
}

async function markFailed(client: OutboxTx, id: string, errorMsg: string): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `UPDATE "${TABLE}"
          SET status     = 'failed',
              last_error = $2,
              claimed_at = NULL,
              worker_id  = NULL
        WHERE id = $1`,
      id,
      errorMsg,
    );
  } catch (err) {
    throw new OutboxAdapterError(`markFailed(${id}) failed`, { cause: err });
  }
}

function defaultWorkerId(): string {
  // `hostname:pid:short-uuid` — human-scannable + unique across restarts.
  const short = randomUUID().slice(0, 8);
  return `${hostname()}:${process.pid}:${short}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
