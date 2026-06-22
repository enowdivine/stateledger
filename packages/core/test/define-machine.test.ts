/**
 * End-to-end tests for `defineMachine` running against the in-memory adapter.
 *
 * Covers the public API surface: bootstrap, declared transitions, invalid
 * transitions, guards, after-callbacks, history, the `.in()` narrowing
 * helper, and rollback when callbacks throw.
 */

import { describe, it, expect, vi } from "vitest";
import {
  defineMachine,
  GuardRejected,
  InvalidTransition,
} from "../src/index.js";
import { InMemoryAdapter } from "@stateledger/memory";

const PAYMENT_CONFIG = {
  name: "payment",
  states: ["pending", "authorized", "captured", "settled", "failed"],
  initialState: "pending",
  transitions: [
    { from: "pending", to: "authorized" },
    { from: "pending", to: "failed" },
    { from: "authorized", to: "captured" },
    { from: "authorized", to: "failed" },
    { from: "captured", to: "settled" },
  ],
} as const;

function freshMachine() {
  const adapter = new InMemoryAdapter();
  const factory = defineMachine(PAYMENT_CONFIG);
  return { factory, adapter };
}

describe("defineMachine", () => {
  describe("bootstrap", () => {
    it("first transition must target initialState", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await expect(m.transitionTo("authorized")).rejects.toBeInstanceOf(InvalidTransition);
    });

    it("first transition to initialState writes a row with from=null", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      const row = await m.transitionTo("pending");
      expect(row.fromState).toBeNull();
      expect(row.toState).toBe("pending");
      expect(row.sortKey).toBe(1);
    });
  });

  describe("declared transitions", () => {
    it("allows a declared transition", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");
      const row = await m.transitionTo("authorized");
      expect(row.fromState).toBe("pending");
      expect(row.toState).toBe("authorized");
      expect(row.sortKey).toBe(2);
    });

    it("rejects an undeclared transition", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");
      // "pending" → "settled" is not declared
      await expect(m.transitionTo("settled")).rejects.toBeInstanceOf(InvalidTransition);
    });

    it("supports a full chain end-to-end", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");
      await m.transitionTo("authorized");
      await m.transitionTo("captured");
      await m.transitionTo("settled");

      const history = await m.history();
      expect(history.map((r) => r.toState)).toEqual([
        "pending",
        "authorized",
        "captured",
        "settled",
      ]);
    });
  });

  describe("guards", () => {
    it("rejects when the guard returns false", async () => {
      const factory = defineMachine({
        ...PAYMENT_CONFIG,
        guards: {
          "pending->authorized": () => false,
        },
      } as const);
      const m = factory.for("p-1", { adapter: new InMemoryAdapter() });
      await m.transitionTo("pending");
      await expect(m.transitionTo("authorized")).rejects.toBeInstanceOf(GuardRejected);
    });

    it("passes subject + actor + from/to to the guard", async () => {
      const guard = vi.fn(() => true);
      const factory = defineMachine({
        ...PAYMENT_CONFIG,
        guards: { "pending->authorized": guard },
      } as const);
      const m = factory.for("p-1", {
        adapter: new InMemoryAdapter(),
        actor: { id: "u-7", type: "USER" },
        subject: { amount: 100 },
      });
      await m.transitionTo("pending");
      await m.transitionTo("authorized");

      expect(guard).toHaveBeenCalledWith({
        subject: { amount: 100 },
        from: "pending",
        to: "authorized",
        actor: { id: "u-7", type: "USER" },
      });
    });
  });

  describe("after-callbacks", () => {
    it("runs the matching after-callback with the same tx", async () => {
      let captured: { from: string; to: string; tx: unknown } | null = null;
      const factory = defineMachine({
        ...PAYMENT_CONFIG,
        callbacks: {
          "after:pending->authorized": (ctx) => {
            captured = { from: ctx.from, to: ctx.to, tx: ctx.tx };
          },
        },
      } as const);
      const m = factory.for("p-1", { adapter: new InMemoryAdapter() });
      await m.transitionTo("pending");
      await m.transitionTo("authorized");

      expect(captured).not.toBeNull();
      expect(captured!.from).toBe("pending");
      expect(captured!.to).toBe("authorized");
      expect(captured!.tx).toBeDefined();
    });

    it("rolls back the transition when the after-callback throws", async () => {
      const factory = defineMachine({
        ...PAYMENT_CONFIG,
        callbacks: {
          "after:pending->authorized": async () => {
            throw new Error("downstream-write-failed");
          },
        },
      } as const);
      const adapter = new InMemoryAdapter();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");

      await expect(m.transitionTo("authorized")).rejects.toThrow("downstream-write-failed");

      // History should only contain the bootstrap.
      const history = await m.history();
      expect(history.map((r) => r.toState)).toEqual(["pending"]);
    });
  });

  describe(".in() narrowing", () => {
    it("delegates to the underlying machine", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");
      const row = await m.in("pending").transitionTo("authorized");
      expect(row.toState).toBe("authorized");
    });

    it(".in('pending').transitionTo('settled') is rejected at runtime too", async () => {
      // We can't easily test the COMPILE-time narrowing in vitest, but we
      // can verify that runtime validation still catches an undeclared
      // transition even when reached via the narrowed helper.
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");
      await expect(
        m.in("pending").transitionTo("settled" as "authorized"),
      ).rejects.toBeInstanceOf(InvalidTransition);
    });
  });

  describe("readCurrent / hasBeenIn", () => {
    it("readCurrent returns null for a fresh subject", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      expect(await m.readCurrent()).toBeNull();
    });

    it("hasBeenIn reflects history", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");
      await m.transitionTo("authorized");
      await m.transitionTo("captured");

      expect(await m.hasBeenIn("authorized")).toBe(true);
      expect(await m.hasBeenIn("settled")).toBe(false);
    });
  });

  describe("stateAt (time-travel)", () => {
    it("returns null when the subject didn't exist at the given moment", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      // Subject never transitioned.
      expect(await m.stateAt(new Date())).toBeNull();
    });

    it("returns the state that was current at the given moment", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });

      await m.transitionTo("pending");
      const tAfterPending = new Date();
      await new Promise((r) => setTimeout(r, 30));

      await m.transitionTo("authorized");
      const tAfterAuthorized = new Date();
      await new Promise((r) => setTimeout(r, 30));

      await m.transitionTo("captured");

      expect(await m.stateAt(tAfterPending)).toBe("pending");
      expect(await m.stateAt(tAfterAuthorized)).toBe("authorized");
      expect(await m.stateAt(new Date())).toBe("captured");
    });

    it("returns null for a moment before the subject's first transition", async () => {
      const { factory, adapter } = freshMachine();
      const m = factory.for("p-1", { adapter });
      await m.transitionTo("pending");

      // 1970 — definitely before any of our test runs.
      expect(await m.stateAt(new Date(0))).toBeNull();
    });
  });
});
