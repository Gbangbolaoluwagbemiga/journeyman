import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * THE EDITOR APPEARS WHEN THE CHAIN CAN ACTUALLY DO IT.
 *
 * The source is ahead of the proxy: setMilestones is written and tested, and
 * the deployed implementation does not have it yet. Shipping the button anyway
 * would give a client a control that reverts, and a revert on a job holding
 * their money is the worst place to discover a version mismatch.
 *
 * So the app asks the chain. A deployed contract's dispatch table carries the
 * selector of every function it answers, which makes its presence in the
 * runtime bytecode a direct answer to "is this live yet" — and unlike calling
 * and catching the revert, it costs nothing and cannot be confused with a guard
 * legitimately refusing somebody who has already started work.
 */

const getBytecode = vi.fn();
const getStorageAt = vi.fn();
const readContract = vi.fn();
const waitForTransactionReceipt = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBytecode,
      getStorageAt,
      readContract: (...a: unknown[]) => readContract(...a),
      waitForTransactionReceipt: (...a: unknown[]) => waitForTransactionReceipt(...a),
    }),
  };
});
vi.mock("@/providers/WalletProvider", () => ({ arcTestnet: { id: 5042002 } }));

const { ContractService, SET_MILESTONES_SELECTOR } = await import("@/lib/web3/contract-service");

/** A dispatch table with the selector in it, and one without. */
const WITH = `0x6080604052${SET_MILESTONES_SELECTOR}8063aabbccdd`;
const WITHOUT = "0x6080604052806312345678638063aabbccdd";

/** The implementation address, as a proxy stores it: left-padded to 32 bytes. */
const IMPL = "0x16789a37a359d141e7fdfd64fa4fb317446c93f6";
const SLOT_VALUE = `0x${"0".repeat(24)}${IMPL.slice(2)}`;

beforeEach(() => {
  vi.clearAllMocks();
  getStorageAt.mockResolvedValue(SLOT_VALUE);
});

describe("detecting whether milestone editing is deployed", () => {
  it("says yes when the selector is in the bytecode", async () => {
    getBytecode.mockResolvedValue(WITH);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(true);
  });

  it("says no against the implementation that predates it", async () => {
    getBytecode.mockResolvedValue(WITHOUT);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });

  it("is case-insensitive, because bytecode casing is not guaranteed", async () => {
    getBytecode.mockResolvedValue(WITH.toUpperCase().replace("0X", "0x"));
    expect(await new ContractService().supportsMilestoneEditing()).toBe(true);
  });

  it("hides the editor rather than guessing when the read fails", async () => {
    // A rate-limited RPC must not produce a button that reverts. Unknown is not
    // yes — and unlike the reads elsewhere in this app, the safe default here is
    // to show less, because the cost of being wrong lands on a funded escrow.
    getBytecode.mockRejectedValue(new Error("rate limit exceeded"));
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });

  it("treats an address with no code as not supporting it", async () => {
    getBytecode.mockResolvedValue(undefined);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });
});


/**
 * IT HAS TO LOOK BEHIND THE PROXY.
 *
 * The first version read the proxy's own bytecode and answered "no" for every
 * function, including addJobFunds, which is unarguably deployed. A UUPS proxy's
 * code is the delegating stub; the dispatch table lives in the implementation.
 *
 * The unit tests passed anyway, because they fed the checker a made-up string.
 * Only asking the real chain showed it up — which is why this one asserts on
 * WHERE it looked, not just on what it concluded.
 */
describe("looking behind the proxy", () => {
  it("reads the implementation's code, not the proxy's", async () => {
    getBytecode.mockResolvedValue(WITH);

    await new ContractService("0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE").supportsMilestoneEditing();

    expect(getStorageAt).toHaveBeenCalled();
    expect(getBytecode).toHaveBeenCalledWith({ address: IMPL });
  });

  it("falls back to the address itself when nothing is proxied", async () => {
    // A bare deployment keeps its dispatch table in its own code.
    getStorageAt.mockResolvedValue(`0x${"0".repeat(64)}`);
    getBytecode.mockResolvedValue(WITH);

    const addr = "0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE";
    expect(await new ContractService(addr).supportsMilestoneEditing()).toBe(true);
    expect(getBytecode).toHaveBeenCalledWith({ address: addr });
  });

  it("still answers no when the implementation predates the function", async () => {
    getBytecode.mockResolvedValue(WITHOUT);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });
});

/**
 * THE APPROVE, AND THE RECEIPT NOBODY READ.
 *
 * The first real edit — two stages on escrow 8, raising the total by 2 USDC —
 * reverted on a missing allowance, and the card announced "Stages updated. You
 * funded 2.00 USDC more, plus the fee on it." over a job that had not changed
 * by a cent. Two independent mistakes stacked:
 *
 *   the contract pulls increase+fee with safeTransferFrom, which needs an
 *   allowance, and setMilestones never asked for one — addJobFunds beside it
 *   has always done exactly that dance
 *
 *   the handler awaited the receipt and then ignored receipt.status, so a
 *   reverted transaction rendered a success toast. That exact bug was fixed in
 *   use-job-manager.ts earlier the same day and not carried across
 */

const getEscrowForEdit = vi.fn();
const quoteDepositMock = vi.fn();

describe("paying for extra stages", () => {
  let cs: InstanceType<typeof ContractService>;
  const write = vi.fn();
  const USDC = "0x3600000000000000000000000000000000000000";
  const ME = "0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41";

  beforeEach(() => {
    vi.clearAllMocks();
    getBytecode.mockResolvedValue(WITH);
    getStorageAt.mockResolvedValue(SLOT_VALUE);
    readContract.mockResolvedValue(0n);           // no allowance yet
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    write.mockResolvedValue("0xhash");

    cs = new ContractService();
    // The escrow being edited: 10 USDC across two stages, ERC-20 funded.
    (cs as unknown as { getEscrow: unknown }).getEscrow = getEscrowForEdit;
    getEscrowForEdit.mockResolvedValue({ token: USDC, totalAmount: "10000000" });
    (cs as unknown as { quoteDeposit: unknown }).quoteDeposit = quoteDepositMock;
    quoteDepositMock.mockResolvedValue({ deposit: 2050000n, fee: 50000n });
  });

  it("approves before asking the contract to pull the increase", async () => {
    await cs.setMilestones(
      { escrow_id: 8, depositor: ME,
        milestones: [{ amount: "9000000", requirements: "a" }, { amount: "3000000", requirements: "b" }] },
      write,
    );

    expect(write).toHaveBeenCalledTimes(2);
    const [approve, edit] = write.mock.calls.map((c) => c[0]);
    expect(approve).toMatchObject({ address: USDC, functionName: "approve", args: [cs.addr, 2050000n] });
    expect(edit.functionName).toBe("setMilestones");
  });

  it("asks for nothing when the total does not go up", async () => {
    // A reduction or a reshuffle moves no money toward the contract, and must
    // not demand an approval the client does not owe.
    await cs.setMilestones(
      { escrow_id: 8, depositor: ME,
        milestones: [{ amount: "5000000", requirements: "a" }] },
      write,
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].functionName).toBe("setMilestones");
  });

  it("skips the approval when the allowance already covers it", async () => {
    readContract.mockResolvedValue(999_000_000n);

    await cs.setMilestones(
      { escrow_id: 8, depositor: ME,
        milestones: [{ amount: "9000000", requirements: "a" }, { amount: "3000000", requirements: "b" }] },
      write,
    );

    expect(write).toHaveBeenCalledTimes(1);
  });
});
