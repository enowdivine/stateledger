/**
 * In-memory adapter for stateledger.
 *
 * Backed by a plain `Map`. Used by the core test suite to validate the
 * contract test pack itself and as a teaching fixture for adapter authors.
 *
 * Implements `Adapter<InMemoryTx>` with pessimistic semantics:
 *   - acquireLock uses a per-`(machine, subjectId)` promise queue so two
 *     concurrent transactions cannot hold the lock at once.
 *   - appendTransition flips the prior mostRecent inside the same
 *     transactional buffer.
 *   - withTransaction commits the buffer on success, discards on throw.
 *
 * Not thread-safe in any meaningful sense; this is a teaching adapter, not
 * a production store.
 */

import type {
  Adapter,
  NewTransitionRow,
  SubjectStateHint,
  TransitionRow,
} from "@stateledger/core";
import { AdapterError } from "@stateledger/core";

type StoredRow = TransitionRow;

/** Opaque transaction handle. The adapter knows how to use it; users don't. */
export type InMemoryTx = {
  readonly id: string;
  /** Pending inserts staged inside this tx — applied to the store on commit. */
  pendingAppends: StoredRow[];
  /** Per-row patches (e.g. flipping mostRecent) staged inside this tx. */
  pendingPatches: Map<string, Partial<StoredRow>>;
  /** Locks held by this tx, released on commit/rollback. */
  heldLocks: Set<string>;
};

/** A simple FIFO mutex per key, used to serialize lock acquisition. */
class KeyedMutex {
  private queues = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.queues.get(key) ?? Promise.resolve();
    this.queues.set(
      key,
      prev.then(() => next),
    );
    await prev;
    return () => {
      // If we're the tail, clean the entry so the map doesn't grow forever.
      if (this.queues.get(key) === prev.then(() => next)) {
        this.queues.delete(key);
      }
      release();
    };
  }
}

export class InMemoryAdapter implements Adapter<InMemoryTx> {
  private rows: StoredRow[] = [];
  private nextId = 1;
  private locks = new KeyedMutex();

  // ── transaction lifecycle ──────────────────────────────────

  async withTransaction<R>(fn: (tx: InMemoryTx) => Promise<R>): Promise<R> {
    const tx: InMemoryTx = {
      id: `tx-${this.nextId++}`,
      pendingAppends: [],
      pendingPatches: new Map(),
      heldLocks: new Set(),
    };

    const releases: Array<() => void> = [];
    // The InMemoryTx tracks its own held locks via heldLocks; we also keep
    // a parallel array of release callbacks so we can free them on
    // commit/rollback without re-querying the mutex.
    (tx as InMemoryTx & { _releases: Array<() => void> })._releases = releases;

    // On success: apply pending writes atomically.
    // On throw: pending buffer is dropped — that's the rollback.
    try {
      const result = await fn(tx);
      for (const [rowId, patch] of tx.pendingPatches) {
        const idx = this.rows.findIndex((r) => r.id === rowId);
        if (idx >= 0) this.rows[idx] = { ...this.rows[idx]!, ...patch } as StoredRow;
      }
      this.rows.push(...tx.pendingAppends);
      return result;
    } finally {
      for (const release of releases) release();
    }
  }

  // ── locking ────────────────────────────────────────────────

  async acquireLock(tx: InMemoryTx, machine: string, subjectId: string): Promise<void> {
    const key = `${machine}::${subjectId}`;
    if (tx.heldLocks.has(key)) return; // re-entrant within same tx
    const release = await this.locks.acquire(key);
    tx.heldLocks.add(key);
    (tx as InMemoryTx & { _releases: Array<() => void> })._releases.push(release);
  }

  // ── reads ──────────────────────────────────────────────────

  async readCurrent(
    tx: InMemoryTx | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow | null> {
    const all = this.snapshot(tx, machine, subjectId);
    const current = all.find((r) => r.mostRecent);
    return current ? { ...current } : null;
  }

  async readHistory(
    tx: InMemoryTx | null,
    machine: string,
    subjectId: string,
  ): Promise<TransitionRow[]> {
    return this.snapshot(tx, machine, subjectId)
      .slice()
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((r) => ({ ...r }));
  }

  async readStateAt(
    tx: InMemoryTx | null,
    machine: string,
    subjectId: string,
    at: Date,
  ): Promise<TransitionRow | null> {
    const cutoff = at.getTime();
    // Most recent row whose createdAt <= cutoff. Sort by sortKey desc and
    // pick the first match — sortKey is monotonic per (machine, subjectId)
    // so ordering by it is equivalent to ordering by createdAt for our
    // append-only history.
    const candidates = this.snapshot(tx, machine, subjectId).filter(
      (r) => r.createdAt.getTime() <= cutoff,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.sortKey - a.sortKey);
    const winner = candidates[0];
    return winner ? { ...winner } : null;
  }

  /**
   * Merge committed rows + this tx's pending appends/patches into a single
   * view. Reads inside a tx see their own pending writes.
   */
  private snapshot(
    tx: InMemoryTx | null,
    machine: string,
    subjectId: string,
  ): StoredRow[] {
    const committed = this.rows.filter(
      (r) => r.machine === machine && r.subjectId === subjectId,
    );
    if (!tx) return committed;

    const patched = committed.map((r) => {
      const patch = tx.pendingPatches.get(r.id);
      return patch ? ({ ...r, ...patch } as StoredRow) : r;
    });
    const pending = tx.pendingAppends.filter(
      (r) => r.machine === machine && r.subjectId === subjectId,
    );
    return [...patched, ...pending];
  }

  // ── writes ─────────────────────────────────────────────────

  async appendTransition(tx: InMemoryTx, row: NewTransitionRow): Promise<TransitionRow> {
    try {
      // Flip the previous mostRecent (in the tx's pending buffer, not committed yet).
      const previousCurrent = (await this.readCurrent(tx, row.machine, row.subjectId)) ?? null;
      if (previousCurrent) {
        tx.pendingPatches.set(previousCurrent.id, { mostRecent: false });
      }

      const inserted: StoredRow = {
        ...row,
        id: `txn-${this.nextId++}`,
        createdAt: new Date(),
      };
      tx.pendingAppends.push(inserted);
      return { ...inserted };
    } catch (err) {
      throw new AdapterError("in-memory append failed", { cause: err });
    }
  }

  async updateSubjectState(
    _tx: InMemoryTx,
    _hint: SubjectStateHint,
    _newState: string,
  ): Promise<void> {
    // Optional method — the in-memory adapter has no subject row to update.
  }
}
