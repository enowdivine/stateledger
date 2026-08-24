/**
 * End-to-end integration tests for @stateledger/outbox.
 *
 * Runs against a real Postgres booted via testcontainers. The suites are
 * grouped by concern (enqueue, worker dispatch, retry/backoff, DLQ,
 * concurrency, stuck-row reclaim, graceful stop) so a failure output
 * points at exactly which invariant broke.
 *
 * Uses the `.integration.ts` extension so the default `pnpm test` skips it
 * — Docker is required to run this suite. Use `pnpm test:integration`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createWorker,
  enqueue,
  enqueueBatch,
  OUTBOX_SCHEMA_STATEMENTS,
  OutboxError,
  UnknownKindError,
  defaultBackoffMs,
} from "../src/index.js";
import type { OutboxHandler, OutboxRecord, WorkerEvent } from "../src/types.js";

import { bootTestPostgres, sleep, waitFor, type TestPostgresHandle } from "./harness.js";

let pg: TestPostgresHandle;

beforeAll(async () => {
  pg = await bootTestPostgres();
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

afterEach(async () => {
  await pg.truncate();
});

/**
 * Small helper for read-only inspection after a test acts on the outbox.
 * Returns rows in insertion order (created_at ASC).
 */
async function allRows(): Promise<OutboxRecord[]> {
  const result = await pg.pool.query(
    `SELECT * FROM "stateledger_outbox" ORDER BY created_at ASC`,
  );
  return result.rows.map((r: any) => ({
    id: r.id,
    kind: r.kind,
    payload: r.payload ?? {},
    region: r.region,
    status: r.status,
    attempts: Number(r.attempts),
    lastError: r.last_error,
    availableAt: r.available_at,
    claimedAt: r.claimed_at,
    workerId: r.worker_id,
    deliveredAt: r.delivered_at,
    createdAt: r.created_at,
  }));
}

async function countByStatus(): Promise<Record<string, number>> {
  const result = await pg.pool.query(
    `SELECT status, COUNT(*)::int AS count FROM "stateledger_outbox" GROUP BY status`,
  );
  return Object.fromEntries(result.rows.map((r: any) => [r.status, r.count]));
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* 1. Schema                                                               */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("schema", () => {
  it("has the outbox table with a valid-status CHECK constraint", async () => {
    // TRUNCATE was applied in afterEach; we should see 0 rows on a fresh scan.
    const rows = await pg.pool.query(`SELECT COUNT(*)::int FROM "stateledger_outbox"`);
    expect(rows.rows[0]!.count).toBe(0);

    // Invalid status rejected by the CHECK constraint.
    await expect(
      pg.pool.query(
        `INSERT INTO "stateledger_outbox" (kind, status) VALUES ($1, $2)`,
        ["x", "bogus"],
      ),
    ).rejects.toThrow();
  });

  it("is safe to re-apply (all statements are IF NOT EXISTS)", async () => {
    for (const stmt of OUTBOX_SCHEMA_STATEMENTS) {
      await pg.pool.query(stmt);
    }
    // Applied twice on the same DB, still nothing broke.
    expect(true).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 2. Enqueue                                                              */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("enqueue", () => {
  it("inserts a pending row with the given kind and payload", async () => {
    const record = await enqueue(pg.tx, {
      kind: "stripe.capture",
      payload: { paymentIntentId: "pi_123", amount: 5000 },
    });

    expect(record.kind).toBe("stripe.capture");
    expect(record.status).toBe("pending");
    expect(record.attempts).toBe(0);
    expect(record.payload).toEqual({ paymentIntentId: "pi_123", amount: 5000 });
    expect(record.region).toBeNull();
    expect(record.deliveredAt).toBeNull();
    expect(record.availableAt).toBeInstanceOf(Date);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(record.id);
  });

  it("stores payload as JSONB round-trippable through nested structures", async () => {
    const complex = {
      user: { id: "u_1", tags: ["a", "b"] },
      counts: { emails: 3, retries: 0 },
      nullable: null,
      unicode: "café ☕",
    };
    const record = await enqueue(pg.tx, { kind: "x", payload: complex });
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual(complex);
    expect(rows[0]!.id).toBe(record.id);
  });

  it("respects an explicit `availableAt` in the future", async () => {
    const future = new Date(Date.now() + 60_000);
    const record = await enqueue(pg.tx, {
      kind: "delayed",
      payload: {},
      availableAt: future,
    });
    // Within a few ms of `future` — pg preserves microseconds.
    expect(Math.abs(record.availableAt.getTime() - future.getTime())).toBeLessThan(2);
  });

  it("stores an explicit region string", async () => {
    const record = await enqueue(pg.tx, {
      kind: "x",
      payload: {},
      region: "af-central",
    });
    expect(record.region).toBe("af-central");
  });

  it("rejects missing/empty kind", async () => {
    await expect(
      // @ts-expect-error - deliberate misuse
      enqueue(pg.tx, { payload: {} }),
    ).rejects.toBeInstanceOf(OutboxError);

    await expect(
      enqueue(pg.tx, { kind: "", payload: {} }),
    ).rejects.toBeInstanceOf(OutboxError);
  });

  it("commits atomically with the caller's transaction (COMMIT case)", async () => {
    await pg.withTransaction(async (tx) => {
      await enqueue(tx, { kind: "a", payload: {} });
      await enqueue(tx, { kind: "b", payload: {} });
    });
    const rows = await allRows();
    expect(rows.map((r) => r.kind)).toEqual(["a", "b"]);
  });

  it("rolls back atomically with the caller's transaction (ROLLBACK case)", async () => {
    await expect(
      pg.withTransaction(async (tx) => {
        await enqueue(tx, { kind: "rolled-back", payload: {} });
        throw new Error("simulated business failure");
      }),
    ).rejects.toThrow("simulated business failure");

    const rows = await allRows();
    expect(rows).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 3. enqueueBatch                                                         */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("enqueueBatch", () => {
  it("inserts multiple rows in one round-trip", async () => {
    const records = await enqueueBatch(pg.tx, [
      { kind: "a", payload: { i: 1 } },
      { kind: "b", payload: { i: 2 } },
      { kind: "c", payload: { i: 3 } },
    ]);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.kind)).toEqual(["a", "b", "c"]);
    const rows = await allRows();
    expect(rows).toHaveLength(3);
  });

  it("empty input is a no-op", async () => {
    const result = await enqueueBatch(pg.tx, []);
    expect(result).toEqual([]);
    const rows = await allRows();
    expect(rows).toHaveLength(0);
  });

  it("rejects if any input is missing kind", async () => {
    await expect(
      enqueueBatch(pg.tx, [
        { kind: "a", payload: {} },
        // @ts-expect-error - deliberate misuse
        { payload: {} },
      ]),
    ).rejects.toBeInstanceOf(OutboxError);
    // Whole batch rejected — nothing persisted.
    const rows = await allRows();
    expect(rows).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 4. Worker: happy path                                                   */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("worker: dispatch happy path", () => {
  it("delivers a pending row through the registered handler", async () => {
    const seen: unknown[] = [];
    await enqueue(pg.tx, { kind: "email", payload: { to: "a@b.c" } });

    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 20,
      handlers: {
        email: async (payload) => {
          seen.push(payload);
        },
      },
    });
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return counts.delivered === 1;
    }, { label: "row delivered" });

    await worker.stop();

    expect(seen).toEqual([{ to: "a@b.c" }]);
    const rows = await allRows();
    expect(rows[0]!.status).toBe("delivered");
    expect(rows[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.workerId).toBeNull(); // cleared on delivery
    expect(rows[0]!.lastError).toBeNull();
  });

  it("emits claimed → delivered events in order", async () => {
    const events: WorkerEvent[] = [];
    await enqueue(pg.tx, { kind: "email", payload: { to: "x@y.z" } });

    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 20,
      handlers: { email: async () => {} },
      onEvent: (event) => events.push(event),
    });
    worker.start();

    await waitFor(async () => events.some((e) => e.type === "delivered"));
    await worker.stop();

    const types = events.map((e) => e.type);
    expect(types).toContain("claimed");
    expect(types).toContain("delivered");
    // Claim must come before delivery for the same run.
    expect(types.indexOf("claimed")).toBeLessThan(types.indexOf("delivered"));
  });

  it("processes multiple rows in FIFO by availableAt/created_at", async () => {
    for (const kind of ["a", "b", "c", "d"]) {
      await enqueue(pg.tx, { kind, payload: {} });
    }
    const seen: string[] = [];
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 10,
      handlers: {
        a: async () => { seen.push("a"); },
        b: async () => { seen.push("b"); },
        c: async () => { seen.push("c"); },
        d: async () => { seen.push("d"); },
      },
    });
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return counts.delivered === 4;
    }, { label: "all four delivered" });
    await worker.stop();

    expect(seen).toEqual(["a", "b", "c", "d"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 5. Worker: retry & backoff                                              */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("worker: retry with backoff", () => {
  it("reschedules on handler failure and increments attempts", async () => {
    await enqueue(pg.tx, { kind: "flaky", payload: {} });

    let calls = 0;
    const events: WorkerEvent[] = [];
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 10,
      // Very short backoff so the test completes quickly.
      backoffMs: () => 50,
      handlers: {
        flaky: async () => {
          calls++;
          if (calls < 3) throw new Error("boom");
        },
      },
      onEvent: (event) => events.push(event),
    });
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return counts.delivered === 1;
    }, { label: "eventually delivered", timeoutMs: 10_000 });
    await worker.stop();

    expect(calls).toBe(3);
    const rows = await allRows();
    expect(rows[0]!.status).toBe("delivered");
    expect(rows[0]!.attempts).toBe(3);

    const rescheduled = events.filter((e) => e.type === "rescheduled");
    expect(rescheduled).toHaveLength(2);
    for (const e of rescheduled) {
      expect(e).toMatchObject({ type: "rescheduled" });
      if (e.type === "rescheduled") {
        expect(e.nextAvailableAt).toBeInstanceOf(Date);
        expect(String(e.error)).toContain("boom");
      }
    }
  });

  it("stores last_error on failure", async () => {
    await enqueue(pg.tx, { kind: "flaky", payload: {} });

    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 10,
      maxAttempts: 10,
      backoffMs: () => 30,
      handlers: {
        flaky: async () => {
          throw new Error("stripe: card_declined");
        },
      },
    });
    worker.start();

    await waitFor(async () => {
      const rows = await allRows();
      return rows[0]?.lastError != null;
    }, { label: "lastError populated" });
    await worker.stop();

    const rows = await allRows();
    expect(rows[0]!.lastError).toContain("card_declined");
  });
});

describe("defaultBackoffMs", () => {
  it("grows exponentially and caps", () => {
    expect(defaultBackoffMs(1)).toBe(1000);
    expect(defaultBackoffMs(2)).toBe(2000);
    expect(defaultBackoffMs(3)).toBe(4000);
    expect(defaultBackoffMs(4)).toBe(8000);
    expect(defaultBackoffMs(20)).toBe(300_000); // capped at 5 minutes
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 6. Worker: dead letter                                                  */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("worker: dead letter queue", () => {
  it("moves a row to failed after maxAttempts is exceeded", async () => {
    await enqueue(pg.tx, { kind: "always-fails", payload: {} });

    const events: WorkerEvent[] = [];
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 10,
      maxAttempts: 3,
      backoffMs: () => 20,
      handlers: {
        "always-fails": async () => {
          throw new Error("nope");
        },
      },
      onEvent: (event) => events.push(event),
    });
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return counts.failed === 1;
    }, { label: "row dead-lettered", timeoutMs: 10_000 });
    await worker.stop();

    const rows = await allRows();
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.attempts).toBe(3);
    expect(rows[0]!.lastError).toContain("nope");

    expect(events.some((e) => e.type === "dead-lettered")).toBe(true);
  });

  it("dead-letters immediately when no handler is registered", async () => {
    await enqueue(pg.tx, { kind: "no-such-handler", payload: {} });

    const events: WorkerEvent[] = [];
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 10,
      handlers: {}, // empty registry
      onEvent: (event) => events.push(event),
    });
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return counts.failed === 1;
    }, { label: "immediately dead-lettered" });
    await worker.stop();

    const rows = await allRows();
    expect(rows[0]!.status).toBe("failed");
    // attempts is bumped once by the claim, then the row is DLQ'd without retry.
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.lastError).toContain("no-such-handler");

    const dlEvents = events.filter((e) => e.type === "unknown-kind");
    expect(dlEvents).toHaveLength(1);

    // UnknownKindError is a class users can match programmatically.
    const err = new UnknownKindError("no-such-handler", rows[0]!.id);
    expect(err).toBeInstanceOf(OutboxError);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 7. Worker: delayed availability                                         */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("worker: delayed availability", () => {
  it("skips rows whose availableAt is in the future", async () => {
    // A row available 500ms from now.
    await enqueue(pg.tx, {
      kind: "later",
      payload: {},
      availableAt: new Date(Date.now() + 500),
    });

    const seen: number[] = [];
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 20,
      handlers: {
        later: async () => {
          seen.push(Date.now());
        },
      },
    });
    const start = Date.now();
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return counts.delivered === 1;
    }, { label: "delayed row eventually delivered" });
    await worker.stop();

    // Delivered no earlier than ~500ms after start.
    expect(seen).toHaveLength(1);
    expect(seen[0]! - start).toBeGreaterThanOrEqual(400); // allow a small clock skew
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 8. Regional routing                                                     */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("worker: regional routing", () => {
  it("region-scoped worker only claims rows for its region (and NULL rows)", async () => {
    await enqueueBatch(pg.tx, [
      { kind: "eu",    payload: {}, region: "eu-west" },
      { kind: "af",    payload: {}, region: "af-central" },
      { kind: "any",   payload: {} }, // region NULL
    ]);

    const seen: string[] = [];
    const euWorker = createWorker({
      client: pg.tx,
      pollIntervalMs: 20,
      region: "eu-west",
      handlers: {
        eu:  async () => { seen.push("eu"); },
        any: async () => { seen.push("any"); },
        // No "af" handler registered — af rows would DLQ if picked up.
      },
    });
    euWorker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return (counts.delivered ?? 0) === 2;
    }, { label: "eu + any delivered by eu worker" });
    await euWorker.stop();

    expect(seen.sort()).toEqual(["any", "eu"]);
    // The af row is still pending; nothing dead-lettered.
    const counts = await countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 9. Concurrency (FOR UPDATE SKIP LOCKED)                                 */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("concurrency: multiple workers claim different rows", () => {
  it("N workers dispatch N rows with no double-processing", async () => {
    const N = 20;
    await enqueueBatch(
      pg.tx,
      Array.from({ length: N }, (_, i) => ({ kind: "work", payload: { i } })),
    );

    const seen = new Set<number>();
    const doubleFires: number[] = [];
    const handler: OutboxHandler<{ i: number }> = async (payload) => {
      if (seen.has(payload.i)) doubleFires.push(payload.i);
      seen.add(payload.i);
    };

    const WORKERS = 4;
    const workers = Array.from({ length: WORKERS }, () =>
      createWorker({
        client: pg.tx,
        pollIntervalMs: 5,
        handlers: { work: handler as OutboxHandler },
      }),
    );
    for (const w of workers) w.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return (counts.delivered ?? 0) === N;
    }, { label: `${N} rows delivered by ${WORKERS} workers`, timeoutMs: 15_000 });

    for (const w of workers) await w.stop();

    expect(seen.size).toBe(N);
    expect(doubleFires).toEqual([]);
    const counts = await countByStatus();
    expect(counts.delivered).toBe(N);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 10. Stuck-row reclaim                                                   */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("stuck-row reclaim", () => {
  it("resets a stale processing row so another worker can pick it up", async () => {
    // Insert a row already claimed 10 minutes ago by a "dead" worker.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    await pg.pool.query(
      `INSERT INTO "stateledger_outbox" (kind, payload, status, worker_id, claimed_at, attempts)
         VALUES ($1, '{}'::jsonb, 'processing', 'dead-worker', $2, 1)`,
      ["orphan", tenMinAgo],
    );

    // A live worker should reclaim it on the next tick and dispatch it.
    let deliveredCount = 0;
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 20,
      handlers: {
        orphan: async () => {
          deliveredCount++;
        },
      },
    });
    worker.start();

    await waitFor(async () => {
      const counts = await countByStatus();
      return (counts.delivered ?? 0) === 1;
    }, { label: "orphan reclaimed + delivered" });
    await worker.stop();

    expect(deliveredCount).toBe(1);
    const rows = await allRows();
    expect(rows[0]!.status).toBe("delivered");
  });
});

/* ═══════════════════════════════════════════════════════════════════════ */
/* 11. Graceful stop                                                       */
/* ═══════════════════════════════════════════════════════════════════════ */

describe("worker: graceful stop", () => {
  it("stop() awaits an in-flight dispatch before resolving", async () => {
    await enqueue(pg.tx, { kind: "slow", payload: {} });

    let handlerReturned = false;
    const worker = createWorker({
      client: pg.tx,
      pollIntervalMs: 10,
      handlers: {
        slow: async () => {
          await sleep(400);
          handlerReturned = true;
        },
      },
    });
    worker.start();

    // Give the worker a chance to claim the row.
    await sleep(80);
    await worker.stop();
    // The handler must have finished — stop() blocks on inFlight.
    expect(handlerReturned).toBe(true);

    // And the row was marked delivered before we returned control.
    const counts = await countByStatus();
    expect(counts.delivered).toBe(1);
    expect(worker.running).toBe(false);
  });

  it("stop() is idempotent and safe to call twice", async () => {
    const worker = createWorker({
      client: pg.tx,
      handlers: {},
    });
    worker.start();
    await worker.stop();
    await worker.stop(); // second call resolves cleanly
    expect(worker.running).toBe(false);
  });
});
