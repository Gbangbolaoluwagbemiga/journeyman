import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * WHO RUNS THIS JOB — one answer, and never a guessed one.
 *
 * Two bugs met here and together they told a client they had taken back control
 * of a job the agent was still managing on-chain.
 *
 * getJobManager swallowed a failed read into `null`, and null MEANS "the client
 * runs this job". And settle() waited for a receipt without ever checking
 * whether the transaction reverted, so a revoke the contract rejected came back
 * through the success path. On the one control somebody reaches for when they
 * want the agent to stop, that is the worst available lie.
 */

const getJobManager = vi.fn();
const revokeJobManager = vi.fn();
const setJobManager = vi.fn();
vi.mock("@/lib/web3/contract-service", () => ({
  contractService: {
    getJobManager: (id: number) => getJobManager(id),
    revokeJobManager: (...a: unknown[]) => revokeJobManager(...a),
    setJobManager: (...a: unknown[]) => setJobManager(...a),
  },
}));

const waitForTransactionReceipt = vi.fn();
vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  usePublicClient: () => ({ waitForTransactionReceipt }),
}));

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xc11e00000000000000000000000000000000000a" } }),
}));

vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchAutopilotAddress: async () => ({ address: "0x6073dfbf2dbd479f87afd5683eaf02d8ad9bf308" }),
}));

const { useJobManager } = await import("@/hooks/use-job-manager");

const AGENT = "0x6073dfbF2dbd479f87AFD5683eAF02D8AD9Bf308";

beforeEach(() => {
  vi.clearAllMocks();
  getJobManager.mockResolvedValue(AGENT);
  revokeJobManager.mockResolvedValue("0xhash");
  waitForTransactionReceipt.mockResolvedValue({ status: "success" });
});

describe("a read that fails", () => {
  it("does not report the job as client-run", async () => {
    // null means "the client runs this", so an RPC failure turning into null
    // flips every surface to the wrong mode.
    getJobManager.mockRejectedValue(new Error("rate limit exceeded"));

    const { result } = renderHook(() => useJobManager(8));

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.loaded).toBe(false);
  });

  it("keeps the answer it already had", async () => {
    const { result } = renderHook(() => useJobManager(8));
    await waitFor(() => expect(result.current.manager).toBe(AGENT));

    getJobManager.mockRejectedValue(new Error("rate limit exceeded"));
    await act(async () => { await result.current.refresh(); });

    expect(result.current.manager).toBe(AGENT);
  });
});

describe("a transaction that reverts", () => {
  it("is not reported as success", async () => {
    // waitForTransactionReceipt resolves just as happily for a reverted
    // transaction, and nothing checked which.
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });

    const { result } = renderHook(() => useJobManager(8));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await expect(result.current.revoke()).rejects.toThrow(/rejected on-chain/i);
  });

  it("says plainly that nothing moved", async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const { result } = renderHook(() => useJobManager(8));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await expect(result.current.revoke()).rejects.toThrow(/money moved/i);
  });
});

describe("two places asking about the same job", () => {
  it("both see a change, so a badge cannot contradict the panel under it", async () => {
    const a = renderHook(() => useJobManager(8));
    const b = renderHook(() => useJobManager(8));
    await waitFor(() => expect(a.result.current.manager).toBe(AGENT));
    await waitFor(() => expect(b.result.current.manager).toBe(AGENT));

    /* One of them takes the job back. The other is the Autopilot badge sitting
       directly above it, which used to keep saying Autopilot through a hard
       refresh because it held its own copy. */
    getJobManager.mockResolvedValue(null);
    await act(async () => { await a.result.current.refresh(); });

    expect(a.result.current.manager).toBeNull();
    await waitFor(() => expect(b.result.current.manager).toBeNull());
  });
});
