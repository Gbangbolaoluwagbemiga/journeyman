import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { minutesUntilClose, type Quest } from "@/lib/atelier/worker";

/**
 * The worker front door's job is to remove every step a wallet normally
 * demands. What is worth testing is the part that survives being wrong:
 * session handling that must not throw in a private window, and the countdown
 * a freelancer decides whether to bother applying by.
 */

const quest = (closesAt: number): Quest => ({
  escrowId: "1",
  title: "Logo",
  budget: 50,
  durationDays: 3,
  criteria: [],
  milestones: [],
  closesAt,
});

describe("minutesUntilClose", () => {
  const now = 1_757_000_000_000;

  it("rounds up, so 'closes in 1 min' never means it already closed", () => {
    expect(minutesUntilClose(quest(now + 30_000), now)).toBe(1);
  });

  it("floors at zero rather than counting backwards", () => {
    // A window that closed an hour ago is judging now, not "-60 min".
    expect(minutesUntilClose(quest(now - 3_600_000), now)).toBe(0);
  });

  it("reports whole minutes for a live window", () => {
    expect(minutesUntilClose(quest(now + 5 * 60_000), now)).toBe(5);
  });
});

describe("session handling", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("remembers and forgets a worker", async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });

    const m = await import("@/lib/atelier/worker");
    expect(m.currentWorkerId()).toBeNull();
    m.rememberWorker("w-1");
    expect(m.currentWorkerId()).toBe("w-1");
    m.forgetWorker();
    expect(m.currentWorkerId()).toBeNull();
  });

  /**
   * The case that matters. Safari's private mode and some hardened browsers
   * throw on localStorage rather than returning null, and a marketplace that
   * white-screens in a private window is worse than one that forgets you.
   */
  it("survives a browser that throws on storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    });

    const m = await import("@/lib/atelier/worker");
    expect(() => m.rememberWorker("w-1")).not.toThrow();
    expect(m.currentWorkerId()).toBeNull();
    expect(() => m.forgetWorker()).not.toThrow();
  });
});
