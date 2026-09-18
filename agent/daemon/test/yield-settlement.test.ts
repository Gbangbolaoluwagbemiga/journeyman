import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE WATERFALL HAD NO CALLER.
 *
 * `distributeYield` is where a freelancer's 60% share of what their escrow
 * earned actually moves. The contract makes it permissionless on purpose, so
 * that the people owed money do not depend on the platform remembering — and
 * the platform did not remember. The function appeared in the Solidity test
 * suite and in no running code at all, so every opted-in job that finished left
 * its earnings sitting in the controller with the freelancer's share in them.
 *
 * These cover the filters, because each one matches a `revert` in the contract.
 * Getting one wrong is not a missed payout, it is a failed transaction once a
 * minute, forever, against a wallet paying gas for it.
 */

process.env.JOURNEYMAN_DEPLOY_BLOCK = "90";

const readContract = vi.fn();
const multicall = vi.fn();
const getBlockNumber = vi.fn(async () => 100n);

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract, multicall, getBlockNumber }),
  };
});

const CONTROLLER = "0x58193bf684325d890ac13537ec7546ecb44e51ca";
const NO_CONTROLLER = "0x0000000000000000000000000000000000000000";

/** Escrow statuses: 0 Pending, 1 InProgress, 2 Released, 3 Refunded, 4 Disputed. */
const RELEASED = 2;
const IN_PROGRESS = 1;
const DISPUTED = 4;

type Row = { status: number; optedIn: boolean; settled: boolean; earned: bigint };

/** Lay out one escrow's four reads in the order the multicall asks for them. */
function rows(...rs: Row[]) {
  return rs.flatMap((r) => [
    { status: "success", result: { status: r.status } },
    { status: "success", result: r.optedIn },
    { status: "success", result: r.settled },
    { status: "success", result: r.earned },
  ]);
}

const EARNING_AND_DONE: Row = { status: RELEASED, optedIn: true, settled: false, earned: 250_000n };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "yieldController") return CONTROLLER;
    if (functionName === "nextEscrowId") return 2n; // one escrow, id 1
    throw new Error(`unexpected read: ${functionName}`);
  });
});

async function pending() {
  const mod = await import("../src/web3/journeyman.js");
  return mod.pendingYieldSettlements();
}

describe("which finished jobs still owe somebody their share", () => {
  it("finds a job that is over, opted in, and has earnings nobody has split", async () => {
    multicall.mockResolvedValue(rows(EARNING_AND_DONE));
    expect(await pending()).toEqual([{ escrowId: 1n, earned: 250_000n }]);
  });

  it("leaves a job that is still running alone", async () => {
    // distributeYield reverts with JobNotFinished — a live escrow may yet
    // unwind more of its position, and settling early pays a smaller number.
    multicall.mockResolvedValue(rows({ ...EARNING_AND_DONE, status: IN_PROGRESS }));
    expect(await pending()).toEqual([]);
  });

  it("leaves a disputed job to the arbiter", async () => {
    multicall.mockResolvedValue(rows({ ...EARNING_AND_DONE, status: DISPUTED }));
    expect(await pending()).toEqual([]);
  });

  it("does not settle a job twice", async () => {
    multicall.mockResolvedValue(rows({ ...EARNING_AND_DONE, settled: true }));
    expect(await pending()).toEqual([]);
  });

  it("ignores a job that never opted in", async () => {
    multicall.mockResolvedValue(rows({ ...EARNING_AND_DONE, optedIn: false }));
    expect(await pending()).toEqual([]);
  });

  it("does not spend a transaction to write a zero", async () => {
    // Nothing to split. Settling would burn gas to mark it settled; leaving it
    // costs only the three reads, every minute, which are free.
    multicall.mockResolvedValue(rows({ ...EARNING_AND_DONE, earned: 0n }));
    expect(await pending()).toEqual([]);
  });

  it("skips an escrow whose reads did not answer, rather than calling it settled", async () => {
    /* The failure shape this codebase keeps paying for. A refused read must not
       become "nothing is owed here" — the sweep runs again in a minute, and the
       contract refuses a second settlement itself, so retrying is free. */
    const partial = rows(EARNING_AND_DONE);
    partial[3] = { status: "failure", error: new Error("rate limit exceeded") } as never;
    multicall.mockResolvedValue(partial);
    expect(await pending()).toEqual([]);
  });

  it("does nothing at all when no controller is attached", async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "yieldController") return NO_CONTROLLER;
      throw new Error("should not have asked anything else");
    });
    expect(await pending()).toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
  });

  it("asks for nothing when no escrow has ever been created", async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "yieldController") return CONTROLLER;
      if (functionName === "nextEscrowId") return 1n;
      throw new Error(`unexpected read: ${functionName}`);
    });
    expect(await pending()).toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
  });
});
