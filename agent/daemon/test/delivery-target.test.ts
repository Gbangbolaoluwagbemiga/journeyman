import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHICH STAGE THIS PANEL IS TALKING ABOUT.
 *
 * `resolveMilestone` picks the stage a delivery is filed against, and the same
 * answer decides which stage the "how did this end" panel describes.
 *
 * It read the stage count from the CHAIN and then went back out to the SUBGRAPH
 * for the statuses, with `catch { return 0 }` around that second call. A 429
 * therefore pointed everything at stage one — and on escrow 7, stage one was
 * the stage that went fine. The freelancer whose SECOND stage an arbiter had
 * taken off them read "Approved and paid in full. Nothing further is needed
 * from you on this one."
 *
 * The chain read already in hand answers both questions. Asking a second,
 * flakier source the same thing was only ever a way to get a worse answer.
 */

const getMilestones = vi.fn();
const graphQuery = vi.fn();
const getEscrow = vi.fn();

vi.mock("../src/web3/atelier.js", () => ({
  getMilestones: (id: bigint) => getMilestones(id),
  getEscrow: (id: bigint) => getEscrow(id),
  hiredEscrowsFor: vi.fn(),
  hasApplied: vi.fn(),
  jobManagerOf: vi.fn(async () => null),
}));

vi.mock("../src/store.js", () => ({
  getWorker: () => ({ id: "w1", walletAddress: "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423" }),
  listTasks: () => [],
  listDecisions: () => [],
  getPollerText: () => null,
  setPollerText: () => {},
  hiredFor: () => null,
  getWorkerByAddress: () => null,
  listWorkers: () => [],
}));

vi.mock("../src/agent/handover.js", () => ({ criteriaFor: () => ({ criteria: [], source: "none" }) }));
vi.mock("../src/config.js", () => ({ config: { applicationWindowMinutes: 3 } }));
vi.mock("../src/graph/client.js", () => ({ graphQuery: (...a: unknown[]) => graphQuery(...a) }));

const { deliveryTarget } = await import("../src/workers/service.js");

/** Escrow 7: stage one approved outright, stage two closed by an arbiter. */
const ESCROW_7 = [
  { status: 2, amount: 3_000_000n, description: "stage one", requirements: "one",
    resolvedAt: 0n, resolutionFreelancerAmount: 0n, resolutionClientAmount: 0n, resolutionReason: "" },
  { status: 2, amount: 2_000_000n, description: "stage two", requirements: "two",
    resolvedAt: 1_789_131_680n, resolutionFreelancerAmount: 0n, resolutionClientAmount: 2_000_000n,
    resolutionReason: "well deserved" },
];

beforeEach(() => {
  vi.clearAllMocks();
  getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 3_000_000n, status: 2 });
  getMilestones.mockResolvedValue(ESCROW_7);
  graphQuery.mockRejectedValue(new Error("GraphQL HTTP 429"));
});

describe("the stage a completed job is described by", () => {
  it("is the last one, even with the subgraph refusing", async () => {
    const target = await deliveryTarget("7");
    expect(target.index).toBe(1);
    expect(target.count).toBe(2);
  });

  it("does not ask the subgraph when the chain already answered", async () => {
    await deliveryTarget("7");
    expect(graphQuery).not.toHaveBeenCalled();
  });

  it("surfaces the arbiter's decision rather than the stage that went fine", async () => {
    const target = await deliveryTarget("7");
    expect(target.disputeOutcome).toBeTruthy();
    expect(target.disputeOutcome!.freelancerUsdc).toBe(0);
    expect(target.disputeOutcome!.clientUsdc).toBe(2);
    expect(target.disputeOutcome!.reason).toBe("well deserved");
  });

  it("points at the first unfinished stage mid-job", async () => {
    getMilestones.mockResolvedValue([
      { ...ESCROW_7[0] },
      { ...ESCROW_7[1], status: 0, resolvedAt: 0n, resolutionClientAmount: 0n },
    ]);

    const target = await deliveryTarget("7");
    expect(target.index).toBe(1);
    expect(target.disputeOutcome).toBeFalsy();
  });
});
