import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * THE DOT ON MY JOBS.
 *
 * It means "somebody applied and you have not decided yet". It was computed
 * from two things — is the job open, does it have applicants — and never from
 * the job's status, so a job the client cancelled months ago went on claiming a
 * decision was waiting on them.
 *
 * A dot that is sometimes wrong is worse than no dot: it stops being read, and
 * then the one that matters is missed too.
 */

const getUserEscrows = vi.fn();
const getEscrow = vi.fn();
const getApplications = vi.fn();

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xC11E27", isConnected: true } }),
}));
vi.mock("@/lib/web3/contract-service", () => ({
  contractService: { getUserEscrows, getApplications, getEscrow },
}));

const { usePendingApprovals } = await import("@/hooks/use-pending-approvals");

const PENDING = 0, IN_PROGRESS = 1, RELEASED = 2, CANCELLED = 6;
const ZERO = "0x0000000000000000000000000000000000000000";

function escrow(over: Record<string, unknown> = {}) {
  return {
    depositor: "0xC11E27",
    beneficiary: ZERO,
    isOpenJob: true,
    status: PENDING,
    ...over,
  };
}

async function badge() {
  const { result } = renderHook(() => usePendingApprovals());
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserEscrows.mockResolvedValue([1]);
  getApplications.mockResolvedValue(["0xAPPLICANT"]);
});

describe("when something really is waiting", () => {
  it("lights up for an open job with an applicant", async () => {
    getEscrow.mockResolvedValue(escrow());
    expect((await badge()).current.hasPendingApprovals).toBe(true);
  });
});

describe("when nothing is", () => {
  /* The one that was wrong: cancelled, but it had received an application. */
  it("stays dark on a cancelled job that once had applicants", async () => {
    getEscrow.mockResolvedValue(escrow({ status: CANCELLED }));
    expect((await badge()).current.hasPendingApprovals).toBe(false);
  });

  it("stays dark on a finished job", async () => {
    getEscrow.mockResolvedValue(escrow({ status: RELEASED }));
    expect((await badge()).current.hasPendingApprovals).toBe(false);
  });

  /* Somebody is already hired and working — the decision was made. */
  it("stays dark once the job is under way", async () => {
    getEscrow.mockResolvedValue(escrow({ status: IN_PROGRESS }));
    expect((await badge()).current.hasPendingApprovals).toBe(false);
  });

  it("stays dark on an open job nobody has applied to", async () => {
    getEscrow.mockResolvedValue(escrow());
    getApplications.mockResolvedValue([]);
    expect((await badge()).current.hasPendingApprovals).toBe(false);
  });

  it("stays dark on somebody else's job", async () => {
    getEscrow.mockResolvedValue(escrow({ depositor: "0xSOMEONEELSE" }));
    expect((await badge()).current.hasPendingApprovals).toBe(false);
  });

  /* A failed read must not invent a decision that is not waiting. */
  it("stays dark when the chain cannot be reached", async () => {
    getUserEscrows.mockRejectedValue(new Error("rpc down"));
    expect((await badge()).current.hasPendingApprovals).toBe(false);
  });
});
