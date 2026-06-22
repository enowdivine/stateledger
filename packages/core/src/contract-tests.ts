/**
 * Generic test pack adapter authors run to verify their adapter honors the
 * {@link Adapter} contract.
 *
 * Usage from an adapter package:
 *
 * ```ts
 * import { runContractTests } from "@stateledger/core/contract-tests";
 *
 * runContractTests({
 *   setup: async () => {
 *     // boot your adapter (real DB, in-memory, whatever)
 *     return {
 *       adapter,
 *       teardown: async () => { /* drop tables, close pool, etc. *\/ },
 *     };
 *   },
 * });
 * ```
 *
 * Requires `vitest` as a peer of the test runner. Adapter packages that use
 * a different runner can read this file as the canonical spec and port it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter } from "./adapter.js";
import type { NewTransitionRow } from "./types.js";

const MACHINE = "test-machine";

/** Result of the per-test setup hook. */
export type ContractTestHarness<TxHandle> = {
  adapter: Adapter<TxHandle>;
  teardown: () => Promise<void>;
};

export type ContractTestOptions<TxHandle> = {
  /**
   * Called before every test. Must return a fresh adapter pointed at a
   * fresh data store. The same harness is torn down after the test.
   */
  setup: () => Promise<ContractTestHarness<TxHandle>>;
  /**
   * Optional label appended to the describe block — useful when running
   * multiple adapter implementations in the same test file.
   */
  label?: string;
};

/**
 * Builds a NewTransitionRow with sensible defaults. Tests only override
 * the fields they care about.
 */
function buildRow(overrides: Partial<NewTransitionRow> & { toState: string }): NewTransitionRow {
  return {
    machine: MACHINE,
    subjectId: "subject-1",
    fromState: null,
    sortKey: 1,
    mostRecent: true,
    actorId: "test",
    actorType: "SYSTEM",
    metadata: {},
    machineVersion: 1,
    ...overrides,
  };
}

export function runContractTests<TxHandle>(options: ContractTestOptions<TxHandle>): void {
  const suiteName = options.label
    ? `Adapter contract (${options.label})`
    : "Adapter contract";

  describe(suiteName, () => {
    let adapter: Adapter<TxHandle>;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      const h = await options.setup();
      adapter = h.adapter;
      teardown = h.teardown;
    });

    afterEach(async () => {
      await teardown();
    });

    // ── readCurrent ──────────────────────────────────────────

    it("readCurrent returns null for a subject that has never transitioned", async () => {
      await adapter.withTransaction(async (tx) => {
        const result = await adapter.readCurrent(tx, MACHINE, "no-such-subject");
        expect(result).toBeNull();
      });
    });

    it("readCurrent returns the most recent transition after an append", async () => {
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(tx, buildRow({ toState: "pending" }));
      });

      await adapter.withTransaction(async (tx) => {
        const current = await adapter.readCurrent(tx, MACHINE, "subject-1");
        expect(current).not.toBeNull();
        expect(current?.toState).toBe("pending");
        expect(current?.mostRecent).toBe(true);
      });
    });

    // ── appendTransition ────────────────────────────────────

    it("appendTransition returns the inserted row with id + createdAt assigned", async () => {
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        const inserted = await adapter.appendTransition(
          tx,
          buildRow({ toState: "pending", metadata: { source: "test" } }),
        );

        expect(inserted.id).toBeTypeOf("string");
        expect(inserted.id.length).toBeGreaterThan(0);
        expect(inserted.createdAt).toBeInstanceOf(Date);
        expect(inserted.toState).toBe("pending");
        expect(inserted.metadata).toEqual({ source: "test" });
        expect(inserted.mostRecent).toBe(true);
      });
    });

    it("appendTransition exposes only one mostRecent row per subject", async () => {
      // First transition
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(tx, buildRow({ toState: "pending", sortKey: 1 }));
      });

      // Second transition — appending must flip the prior mostRecent to false
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(
          tx,
          buildRow({ fromState: "pending", toState: "authorized", sortKey: 2 }),
        );
      });

      const history = await adapter.readHistory(null, MACHINE, "subject-1");
      const mostRecentRows = history.filter((r) => r.mostRecent);
      expect(mostRecentRows).toHaveLength(1);
      expect(mostRecentRows[0]?.toState).toBe("authorized");
    });

    // ── readHistory ─────────────────────────────────────────

    it("readHistory returns rows in ascending sortKey order", async () => {
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(tx, buildRow({ toState: "pending", sortKey: 1 }));
      });
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(
          tx,
          buildRow({ fromState: "pending", toState: "authorized", sortKey: 2 }),
        );
      });
      await adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        await adapter.appendTransition(
          tx,
          buildRow({ fromState: "authorized", toState: "captured", sortKey: 3 }),
        );
      });

      const history = await adapter.readHistory(null, MACHINE, "subject-1");
      expect(history.map((r) => r.toState)).toEqual(["pending", "authorized", "captured"]);
      expect(history.map((r) => r.sortKey)).toEqual([1, 2, 3]);
    });

    it("readHistory returns an empty array for an unknown subject", async () => {
      const history = await adapter.readHistory(null, MACHINE, "no-such-subject");
      expect(history).toEqual([]);
    });

    // ── readStateAt ─────────────────────────────────────────

    it("readStateAt returns null when no transition exists at or before the cutoff", async () => {
      // Subject has never transitioned at all.
      const row = await adapter.readStateAt(null, MACHINE, "ghost-subject", new Date());
      expect(row).toBeNull();

      // Subject exists, but the cutoff is before its first transition.
      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ subjectId: "s1", toState: "pending", sortKey: 1 }));
      });
      const before = new Date(0); // 1970 — well before now
      const row2 = await adapter.readStateAt(null, MACHINE, "s1", before);
      expect(row2).toBeNull();
    });

    it("readStateAt returns the transition that was current at the moment", async () => {
      // Append three transitions with a small wait so timestamps differ.
      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ subjectId: "s1", toState: "pending", sortKey: 1 }));
      });
      const tAfterFirst = new Date();
      await new Promise((r) => setTimeout(r, 50));

      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ subjectId: "s1", fromState: "pending", toState: "authorized", sortKey: 2, mostRecent: true }));
      });
      const tAfterSecond = new Date();
      await new Promise((r) => setTimeout(r, 50));

      await adapter.withTransaction(async (tx) => {
        await adapter.appendTransition(tx, buildRow({ subjectId: "s1", fromState: "authorized", toState: "captured", sortKey: 3, mostRecent: true }));
      });

      // At `tAfterFirst` only the first transition existed → "pending"
      const at1 = await adapter.readStateAt(null, MACHINE, "s1", tAfterFirst);
      expect(at1?.toState).toBe("pending");

      // At `tAfterSecond` two transitions existed → "authorized"
      const at2 = await adapter.readStateAt(null, MACHINE, "s1", tAfterSecond);
      expect(at2?.toState).toBe("authorized");

      // At now (after all three) → "captured"
      const at3 = await adapter.readStateAt(null, MACHINE, "s1", new Date());
      expect(at3?.toState).toBe("captured");
    });

    // ── withTransaction ─────────────────────────────────────

    it("withTransaction returns the function result on success", async () => {
      const result = await adapter.withTransaction(async () => "ok");
      expect(result).toBe("ok");
    });

    it("withTransaction rolls back when the function throws", async () => {
      await expect(
        adapter.withTransaction(async (tx) => {
          await adapter.acquireLock(tx, MACHINE, "subject-1");
          await adapter.appendTransition(tx, buildRow({ toState: "pending" }));
          throw new Error("simulated business-logic failure");
        }),
      ).rejects.toThrow("simulated business-logic failure");

      // No transition row should have survived.
      const history = await adapter.readHistory(null, MACHINE, "subject-1");
      expect(history).toEqual([]);
    });

    // ── Concurrency ──────────────────────────────────────────

    it("concurrent transitions on different subjects do not block each other", async () => {
      // Both should complete without serializing. We don't measure timing
      // (flaky), only that both succeed and produce their expected rows.
      await Promise.all([
        adapter.withTransaction(async (tx) => {
          await adapter.acquireLock(tx, MACHINE, "subject-A");
          await adapter.appendTransition(
            tx,
            buildRow({ subjectId: "subject-A", toState: "pending" }),
          );
        }),
        adapter.withTransaction(async (tx) => {
          await adapter.acquireLock(tx, MACHINE, "subject-B");
          await adapter.appendTransition(
            tx,
            buildRow({ subjectId: "subject-B", toState: "pending" }),
          );
        }),
      ]);

      const a = await adapter.readHistory(null, MACHINE, "subject-A");
      const b = await adapter.readHistory(null, MACHINE, "subject-B");
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("concurrent transitions on the same subject serialize cleanly", async () => {
      // Both writers race to be the first transition. The adapter's locking
      // (pessimistic or optimistic) must surface exactly one as the winner
      // — the other either waits and then sees the winner's row, or fails
      // with OptimisticConcurrencyError.
      let bWaitedForA = false;

      const a = adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        // Sleep briefly so B has a chance to start and (in pessimistic mode) block.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await adapter.appendTransition(tx, buildRow({ toState: "pending", sortKey: 1 }));
      });

      const b = adapter.withTransaction(async (tx) => {
        await adapter.acquireLock(tx, MACHINE, "subject-1");
        // If we got here after A committed (pessimistic), the current row exists.
        const current = await adapter.readCurrent(tx, MACHINE, "subject-1");
        if (current) bWaitedForA = true;
        await adapter.appendTransition(
          tx,
          buildRow({
            fromState: current?.toState ?? null,
            toState: bWaitedForA ? "authorized" : "pending",
            sortKey: current ? current.sortKey + 1 : 1,
          }),
        );
      });

      // Either both succeed in series (pessimistic) or one fails with
      // OptimisticConcurrencyError (optimistic). Both are valid contract
      // outcomes; the invariant we check is "exactly one mostRecent at
      // the end" — never two.
      const results = await Promise.allSettled([a, b]);
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      expect(succeeded).toBeGreaterThanOrEqual(1);

      const history = await adapter.readHistory(null, MACHINE, "subject-1");
      const mostRecent = history.filter((r) => r.mostRecent);
      expect(mostRecent).toHaveLength(1);
    });
  });
}
