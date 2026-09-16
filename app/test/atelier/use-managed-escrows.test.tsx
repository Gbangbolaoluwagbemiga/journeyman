import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * WHICH JOBS AUTOPILOT RUNS — two sources, one answer.
 *
 * The board reads the daemon's task table: one request for the whole page
 * instead of an RPC call per card. That is the right trade and it means the
 * board lags a hand-over by the agent's next sweep.
 *
 * My Jobs reads the chain directly, so it is instant. The two live on separate
 * routes, so a client who delegates and then walks to the board sees their own
 * action undone by a slower source — badge gone, exactly what it looked like
 * before the delegation.
 */

const fetchManagedEscrowIds = vi.fn();
vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchManagedEscrowIds: (s?: AbortSignal) => fetchManagedEscrowIds(s),
}));

const knownJobManagers = vi.fn();
const rememberJobManagers = vi.fn();
vi.mock("@/hooks/use-job-manager", () => ({
  JOB_MANAGER_EVENT: "atelier:job-manager",
  knownJobManagers: () => knownJobManagers(),
  rememberJobManagers: (m: unknown) => rememberJobManagers(m),
}));

const getJobManagersBatch = vi.fn();
vi.mock("@/lib/web3/contract-service", () => ({
  contractService: { getJobManagersBatch: (ids: number[]) => getJobManagersBatch(ids) },
}));

const { useManagedEscrows } = await import("@/hooks/use-managed-escrows");

beforeEach(() => {
  vi.clearAllMocks();
  fetchManagedEscrowIds.mockResolvedValue(new Set<string>());
  knownJobManagers.mockReturnValue({ managed: new Set(), unmanaged: new Set() });
  getJobManagersBatch.mockResolvedValue({});
});

describe("merging what this browser already knows", () => {
  it("shows a delegation the daemon has not swept yet", async () => {
    fetchManagedEscrowIds.mockResolvedValue(new Set<string>());
    knownJobManagers.mockReturnValue({ managed: new Set(["8"]), unmanaged: new Set() });

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.managed.has("8")).toBe(true));
  });

  it("hides a revocation the daemon still lists", async () => {
    // The other direction matters just as much: the agent is locked out
    // on-chain the moment it is revoked, so advertising it is a false claim.
    fetchManagedEscrowIds.mockResolvedValue(new Set(["8"]));
    knownJobManagers.mockReturnValue({ managed: new Set(), unmanaged: new Set(["8"]) });

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.managed.has("8")).toBe(false);
  });

  it("keeps the daemon's answer for jobs this browser has not read", async () => {
    // Someone else's delegation is the daemon's to report, and it is right.
    fetchManagedEscrowIds.mockResolvedValue(new Set(["2", "5"]));
    knownJobManagers.mockReturnValue({ managed: new Set(), unmanaged: new Set() });

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.managed.size).toBe(2));
    expect(result.current.managed.has("2")).toBe(true);
  });

  it("still shows nothing when the daemon is unreachable and nothing is known", async () => {
    // A missing badge under-claims, which is the safe direction for a label a
    // freelancer relies on.
    fetchManagedEscrowIds.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.managed.size).toBe(0);
  });
});


/**
 * AS CURRENT AS THE CHAIN, NOT AS THE AGENT'S HOUSEKEEPING.
 *
 * The board read the daemon's task table to avoid a request per card, and paid
 * for it with lag: the agent only learns about a hand-over on its next sweep,
 * so the badge could be most of a minute behind. multicall3 answers for every
 * job on the page in one round trip, which makes that trade unnecessary.
 */
describe("reading the badge from the chain", () => {
  it("asks once for every job on the page", async () => {
    getJobManagersBatch.mockResolvedValue({ 8: "0x6073", 9: null });

    const { result } = renderHook(() => useManagedEscrows([8, 9]));

    await waitFor(() => expect(result.current.managed.has("8")).toBe(true));
    expect(result.current.managed.has("9")).toBe(false);
    expect(getJobManagersBatch).toHaveBeenCalledTimes(1);
    expect(getJobManagersBatch).toHaveBeenCalledWith([8, 9]);
  });

  it("does not ask the daemon when the chain answered", async () => {
    getJobManagersBatch.mockResolvedValue({ 8: "0x6073" });

    const { result } = renderHook(() => useManagedEscrows([8]));

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(fetchManagedEscrowIds).not.toHaveBeenCalled();
  });

  it("shares what it read, so opening the job does not ask again", async () => {
    const managers = { 8: "0x6073" };
    getJobManagersBatch.mockResolvedValue(managers);

    renderHook(() => useManagedEscrows([8]));

    await waitFor(() => expect(rememberJobManagers).toHaveBeenCalledWith(managers));
  });

  it("falls back to the daemon when the chain will not answer", async () => {
    // A late badge beats no badge, and the daemon survives an RPC refusing.
    getJobManagersBatch.mockRejectedValue(new Error("rate limit exceeded"));
    fetchManagedEscrowIds.mockResolvedValue(new Set(["8"]));

    const { result } = renderHook(() => useManagedEscrows([8]));

    await waitFor(() => expect(result.current.managed.has("8")).toBe(true));
    expect(fetchManagedEscrowIds).toHaveBeenCalled();
  });

  it("asks the daemon when there is nothing on screen to ask about", async () => {
    fetchManagedEscrowIds.mockResolvedValue(new Set(["2"]));

    const { result } = renderHook(() => useManagedEscrows([]));

    await waitFor(() => expect(result.current.managed.has("2")).toBe(true));
    expect(getJobManagersBatch).not.toHaveBeenCalled();
  });
});
