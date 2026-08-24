/**
 * `enqueue` — insert an outbox row that joins the caller's transaction.
 *
 * Typical use is from inside a stateledger after-callback:
 *
 *   defineMachine({
 *     ...,
 *     callbacks: {
 *       "after:pending->authorized": async ({ tx, subject }) => {
 *         await enqueue(tx, {
 *           kind: "stripe.authorize",
 *           payload: { paymentIntentId: subject.stripeId },
 *         });
 *       },
 *     },
 *   });
 *
 * Because `tx` is the same handle the transition write uses, the outbox
 * insert and the transition row commit together or roll back together. The
 * pattern's atomicity guarantee lives here — misuse it (passing a top-level
 * client outside a transaction) and you lose that guarantee.
 */

import { OutboxAdapterError } from "./errors.js";
import type { EnqueueInput, OutboxRecord, OutboxTx } from "./types.js";

/**
 * Raw row shape returned by the INSERT RETURNING query, before mapping to
 * the camelCase public shape.
 */
type RawOutboxRow = {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  region: string | null;
  status: "pending" | "processing" | "delivered" | "failed";
  attempts: number | bigint;
  last_error: string | null;
  available_at: Date | string;
  claimed_at: Date | string | null;
  worker_id: string | null;
  delivered_at: Date | string | null;
  created_at: Date | string;
};

const TABLE = "stateledger_outbox";

/**
 * Insert one row into the outbox. Returns the persisted record, including
 * the DB-assigned id and timestamps.
 *
 * `tx` must be inside an open transaction if you want the atomicity
 * guarantee — otherwise the note commits independently of your state change.
 * That's usually not what you want.
 */
export async function enqueue<Payload extends Record<string, unknown>>(
  tx: OutboxTx,
  input: EnqueueInput<Payload>,
): Promise<OutboxRecord<Payload>> {
  if (!input.kind || typeof input.kind !== "string") {
    throw new OutboxAdapterError("enqueue: `kind` is required (non-empty string).");
  }

  try {
    const rows = await tx.$queryRawUnsafe<RawOutboxRow[]>(
      `INSERT INTO "${TABLE}" (kind, payload, region, available_at)
         VALUES ($1, $2::jsonb, $3, COALESCE($4, NOW()))
         RETURNING *`,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.region ?? null,
      input.availableAt ?? null,
    );
    const row = rows[0];
    if (!row) {
      throw new OutboxAdapterError(
        `enqueue(${input.kind}): INSERT returned no rows`,
      );
    }
    return mapRow<Payload>(row);
  } catch (err) {
    if (err instanceof OutboxAdapterError) throw err;
    throw new OutboxAdapterError(
      `enqueue(${input.kind}): insert failed`,
      { cause: err },
    );
  }
}

/**
 * Small utility: bulk-insert multiple outbox rows in one call. Same
 * atomicity contract as `enqueue` — pass a `tx` inside your business
 * transaction and every row commits together with your state change.
 *
 * Uses a single INSERT with multiple VALUES rows rather than N round-trips.
 */
export async function enqueueBatch<Payload extends Record<string, unknown>>(
  tx: OutboxTx,
  inputs: readonly EnqueueInput<Payload>[],
): Promise<OutboxRecord<Payload>[]> {
  if (inputs.length === 0) return [];
  for (const input of inputs) {
    if (!input.kind || typeof input.kind !== "string") {
      throw new OutboxAdapterError("enqueueBatch: every input needs `kind`.");
    }
  }

  // Build ($1, $2::jsonb, $3, COALESCE($4, NOW())), ($5, $6::jsonb, ...), ...
  const cols = 4;
  const valuesSql = inputs
    .map((_, i) => {
      const base = i * cols;
      return `($${base + 1}, $${base + 2}::jsonb, $${base + 3}, COALESCE($${base + 4}, NOW()))`;
    })
    .join(", ");
  const params: unknown[] = [];
  for (const input of inputs) {
    params.push(
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.region ?? null,
      input.availableAt ?? null,
    );
  }

  try {
    const rows = await tx.$queryRawUnsafe<RawOutboxRow[]>(
      `INSERT INTO "${TABLE}" (kind, payload, region, available_at)
         VALUES ${valuesSql}
         RETURNING *`,
      ...params,
    );
    return rows.map((r) => mapRow<Payload>(r));
  } catch (err) {
    throw new OutboxAdapterError(
      `enqueueBatch(n=${inputs.length}): insert failed`,
      { cause: err },
    );
  }
}

/** Convert the snake_case DB row shape into the public camelCase record. */
export function mapRow<Payload>(raw: RawOutboxRow): OutboxRecord<Payload> {
  return {
    id: raw.id,
    kind: raw.kind,
    payload: (raw.payload ?? {}) as Payload,
    region: raw.region,
    status: raw.status,
    attempts: Number(raw.attempts),
    lastError: raw.last_error,
    availableAt: toDate(raw.available_at),
    claimedAt: raw.claimed_at == null ? null : toDate(raw.claimed_at),
    workerId: raw.worker_id,
    deliveredAt: raw.delivered_at == null ? null : toDate(raw.delivered_at),
    createdAt: toDate(raw.created_at),
  };
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}
