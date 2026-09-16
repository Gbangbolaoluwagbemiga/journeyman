import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN UNAVAILABLE SOURCE IS NOT AN EMPTY ANSWER.
 *
 * `hiredEscrowsFor` asks every escrow who its beneficiary is. That read was a
 * loop of one request per escrow with `catch { return null }` around each one,
 * so when the public RPC answered `rate limit exceeded` — which it does, partly
 * BECAUSE this was N requests — every read failed, every failure became a null,
 * and the filter handed back a clean empty array.
 *
 * Nothing downstream could tell that apart from "this person has never been
 * hired". A freelancer opened their board and their finished job was gone, with
 * their money apparently gone with it. This is the third time this exact shape
 * has cost real time in this codebase, which is why it has a test now.
 */

/* A deploy block near the head, so the log-walk fallback is one window rather
   than the six thousand a real deploy block would make it. */
process.env.ATELIER_DEPLOY_BLOCK = "90";

const readContract = vi.fn();
const multicall = vi.fn();
const getLogs = vi.fn();
const getBlockNumber = vi.fn(async () => 100n);

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract, multicall, getLogs, getBlockNumber }),
  };
});

const ME = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423" as `0x${string}`;
const SOMEONE_ELSE = "0xfC360000000000000000000000000000000003Bd1".toLowerCase();

/** Four escrows exist; the RPC is asked about three of them (ids 1..3). */
const THREE_ESCROWS = 4n;

beforeEach(() => {
  vi.clearAllMocks();
  readContract.mockResolvedValue(THREE_ESCROWS);
  getLogs.mockResolvedValue([]);
});

async function hiredEscrowsFor(who: `0x${string}`) {
  const mod = await import("../src/web3/atelier.js");
  return mod.hiredEscrowsFor(who);
}

describe("which escrows this person was hired for", () => {
  it("returns the ones they are the beneficiary of", async () => {
    multicall.mockResolvedValue([
      { status: "success", result: { beneficiary: SOMEONE_ELSE } },
      { status: "success", result: { beneficiary: ME } },
      { status: "success", result: { beneficiary: SOMEONE_ELSE } },
    ]);

    expect(await hiredEscrowsFor(ME)).toEqual([2n]);
  });

  it("matches however the address was spelled", async () => {
    // The chain hands back a checksummed address; the managed wallet is lowercase.
    multicall.mockResolvedValue([
      { status: "success", result: { beneficiary: "0x8289DA3F656FB9AFB94E1074C7E88F0AD98AC423" } },
      { status: "success", result: { beneficiary: SOMEONE_ELSE } },
      { status: "success", result: { beneficiary: SOMEONE_ELSE } },
    ]);

    expect(await hiredEscrowsFor(ME)).toEqual([1n]);
  });

  it("asks for every escrow in ONE request", async () => {
    multicall.mockResolvedValue([
      { status: "success", result: { beneficiary: ME } },
      { status: "success", result: { beneficiary: ME } },
      { status: "success", result: { beneficiary: ME } },
    ]);

    await hiredEscrowsFor(ME);

    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]![0].contracts).toHaveLength(3);
  });

  it("refuses to answer when a single escrow did not answer", async () => {
    /* The dangerous case, and the one that shipped: two escrows are not this
       person's and the third could not be read. Filtering would produce [] —
       indistinguishable from "never hired" — so the read must fail loudly. */
    multicall.mockResolvedValue([
      { status: "success", result: { beneficiary: SOMEONE_ELSE } },
      { status: "failure", error: new Error("rate limit exceeded") },
      { status: "success", result: { beneficiary: SOMEONE_ELSE } },
    ]);
    getLogs.mockRejectedValue(new Error("rate limit exceeded"));

    await expect(hiredEscrowsFor(ME)).rejects.toThrow();
  });

  it("says nothing rather than nothing-confidently when the RPC is refusing", async () => {
    multicall.mockRejectedValue(new Error("rate limit exceeded"));
    getLogs.mockRejectedValue(new Error("rate limit exceeded"));

    await expect(hiredEscrowsFor(ME)).rejects.toThrow();
  });

  it("falls through to the log walk when the direct scan cannot answer", async () => {
    // A second source is not a shrug: if logs CAN answer, that is a real answer.
    multicall.mockRejectedValue(new Error("rate limit exceeded"));
    getLogs.mockResolvedValue([{ args: { escrowId: 7n } }]);

    expect(await hiredEscrowsFor(ME)).toEqual([7n]);
  });
});
