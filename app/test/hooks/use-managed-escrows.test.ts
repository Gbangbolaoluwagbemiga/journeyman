import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/*
 * `waitFor` is deliberately not used anywhere below: it polls on real timers,
 * and these tests fake them to drive the interval. Flushing with
 * advanceTimersByTimeAsync(0) settles the mounting fetch instead.
 */

/**
 * THE AUTOPILOT BADGE ON THE JOB BOARD.
 *
 * This read the daemon's task table once, on mount, and never again — with no
 * way for anything to ask it to look a second time. So handing a job to
 * Autopilot changed nothing on the board: the job list refetched happily, the
 * badge stayed missing, and only a full page reload brought it back, because a
 * reload remounts the hook. The Refresh button spun and could not have helped.
 *
 * Two clocks have to line up and only one is ours. Delegation is on-chain
 * immediately; the daemon learns about it on its next sweep, fifteen seconds
 * later. So this polls under that interval — asking faster than the answer can
 * change would be noise — and exposes a refresh for the button.
 */

const fetchManagedEscrowIds = vi.fn();

vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchManagedEscrowIds,
}));

const { useManagedEscrows } = await import("@/hooks/use-managed-escrows");

beforeEach(() => {
  vi.useFakeTimers();
  fetchManagedEscrowIds.mockReset();
  fetchManagedEscrowIds.mockResolvedValue(new Set<string>());
});
afterEach(() => vi.useRealTimers());

describe("keeping up with the agent", () => {
  it("reads the managed set on mount", async () => {
    fetchManagedEscrowIds.mockResolvedValue(new Set(["7"]));
    const { result } = renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.managed.has("7")).toBe(true);
  });

  /* The bug: a job handed over after mount never got its badge. */
  it("picks up a job delegated after the page loaded", async () => {
    const { result } = renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.managed.has("7")).toBe(false);

    fetchManagedEscrowIds.mockResolvedValue(new Set(["7"]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.managed.has("7")).toBe(true);
  });

  /* Below the daemon's 15s sweep — the answer cannot arrive before it has it. */
  it("polls faster than the agent's own sweep", async () => {
    renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchManagedEscrowIds.mock.calls.length).toBeGreaterThan(1);
  });

  it("asks again immediately when refresh is called", async () => {
    const { result } = renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
    const before = fetchManagedEscrowIds.mock.calls.length;

    fetchManagedEscrowIds.mockResolvedValue(new Set(["9"]));
    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchManagedEscrowIds.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.managed.has("9")).toBe(true);
  });

  it("stops polling once the board is closed", async () => {
    const { unmount } = renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const after = fetchManagedEscrowIds.mock.calls.length;

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchManagedEscrowIds.mock.calls.length).toBe(after);
  });
});

/**
 * A missing badge under-claims, and under-claiming is the safe direction for a
 * label a freelancer is deciding on.
 */
describe("when the agent cannot be reached", () => {
  it("shows no badges rather than breaking the board", async () => {
    fetchManagedEscrowIds.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.managed.size).toBe(0);
  });

  it("keeps trying, so the badge returns when the agent does", async () => {
    fetchManagedEscrowIds.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useManagedEscrows());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);

    fetchManagedEscrowIds.mockResolvedValue(new Set(["7"]));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.managed.has("7")).toBe(true);
  });
});
