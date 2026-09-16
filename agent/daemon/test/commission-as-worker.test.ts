import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A MANAGED WORKER HIRING SOMEBODY.
 *
 * The supply side was allowed to earn and nothing else: apply, deliver, get
 * paid, withdraw — and the moment they wanted to hire, the app told them to
 * connect a wallet while showing them their own address and balance.
 *
 * Nothing about custody forbade it. The daemon already signs applyToJob,
 * startWork, submitMilestone and withdraw on a worker's instruction, every one
 * of which moves value or commits them to work.
 *
 * What this has to get right is the order: it spends somebody's custodial
 * balance, and they have no mempool to go and read. Every check belongs in
 * front of the first signature, because a revert after an approve costs them
 * gas and leaves them with no job and no sentence explaining why.
 */

const ME = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";
const AGENT = "0x6073dfbF2dbd479f87AFD5683eAF02D8AD9Bf308";

const getWorker = vi.fn();
const insertTask = vi.fn();
const updateTaskBrief = vi.fn();
const updateTaskStatus = vi.fn();
const createEscrow = vi.fn();
const quoteDeposit = vi.fn();
const workerBalance = vi.fn();
const dripGas = vi.fn();
const createSignerFor = vi.fn(() => ({ address: ME }));
const setJobManager = vi.fn();
const setYieldOptIn = vi.fn();

vi.mock("../src/store.js", () => ({
  getWorker: (id: string) => getWorker(id),
  insertTask: (t: unknown) => insertTask(t),
  updateTaskBrief: (a: string, b: string) => updateTaskBrief(a, b),
  updateTaskStatus: (a: string, b: string, c?: string) => updateTaskStatus(a, b, c),
  listTasks: () => [],
  listDecisions: () => [],
  getPollerText: () => null,
  setPollerText: () => {},
  hiredFor: () => null,
  getWorkerByAddress: () => null,
  listWorkers: () => [],
}));

vi.mock("../src/web3/atelier.js", () => ({
  createEscrow: (p: unknown, s: unknown) => createEscrow(p, s),
  setJobManager: (a: bigint, b: string, c: unknown) => setJobManager(a, b, c),
  setYieldOptIn: (a: bigint, b: boolean, c: unknown) => setYieldOptIn(a, b, c),
  quoteDeposit: (t: bigint) => quoteDeposit(t),
  hiredEscrowsFor: vi.fn(),
  hasApplied: vi.fn(),
  getEscrow: vi.fn(),
  getMilestones: vi.fn(),
  jobManagerOf: vi.fn(),
}));

vi.mock("../src/workers/wallets.js", () => ({
  workerBalance: (a: string) => workerBalance(a),
  dripGas: (a: string) => dripGas(a),
  provisionWorkerWallet: vi.fn(),
  withdrawTo: vi.fn(),
}));

vi.mock("../src/circle/circleSigner.js", () => ({
  createSignerFor: (a: string) => createSignerFor(a),
  signMessageAsWallet: vi.fn(),
}));

vi.mock("../src/agent/handover.js", () => ({
  criteriaFor: () => ({ criteria: [], source: "none" }),
  previewCriteria: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  config: { applicationWindowMinutes: 3, circleWalletAddress: AGENT },
}));
vi.mock("../src/graph/client.js", () => ({ graphQuery: vi.fn(), isGraphConfigured: () => false }));

const { commissionAsWorker } = await import("../src/workers/service.js");

/** A 5 USDC job in two stages, and a wallet that can afford it with fee. */
const GOOD = {
  workerId: "w1",
  instruction: "A logo for a coffee roastery",
  title: "Roastery logo",
  budgetUsdc: 5,
  durationDays: 3,
  milestones: [
    { description: "Three concepts", amount: 3 },
    { description: "Final artwork", amount: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getWorker.mockReturnValue({ id: "w1", walletAddress: ME, mode: "managed" });
  // 5 USDC budget + 2.5% fee = 5.125 deposit
  quoteDeposit.mockResolvedValue({ deposit: 5_125_000n, fee: 125_000n });
  workerBalance.mockResolvedValue("10.00");
  dripGas.mockResolvedValue(undefined);
  createEscrow.mockResolvedValue({ escrowId: 12n, txHash: "0xtx" });
  setJobManager.mockResolvedValue("0xhandover");
  setYieldOptIn.mockResolvedValue("0xyield");
});

describe("posting a job from a managed wallet", () => {
  it("funds it with the worker's own wallet, not the agent's", async () => {
    // The depositor is whoever signs, and the depositor is who the contract
    // answers to for refunds, cancellation and the yield term.
    await commissionAsWorker(GOOD);

    expect(createSignerFor).toHaveBeenCalledWith(ME);
    expect(createEscrow.mock.calls[0][1]).toEqual({ address: ME });
  });

  it("passes the milestones through in base units", async () => {
    await commissionAsWorker(GOOD);

    const params = createEscrow.mock.calls[0][0];
    expect(params.totalAmount).toBe(5_000_000n);
    expect(params.milestoneAmounts).toEqual([3_000_000n, 2_000_000n]);
    expect(params.milestoneDescriptions).toEqual(["Three concepts", "Final artwork"]);
  });

  it("records it as a person hiring, not the agent", async () => {
    await commissionAsWorker(GOOD);

    expect(insertTask.mock.calls[0][0]).toMatchObject({
      clientType: "human",
      clientAddress: ME,
    });
  });

  it("returns the escrow and the transaction that funded it", async () => {
    await expect(commissionAsWorker(GOOD)).resolves.toMatchObject({
      escrowId: "12",
      txHash: "0xtx",
    });
  });
});

describe("the checks that happen before the first signature", () => {
  it("refuses when the wallet cannot cover budget AND fee", async () => {
    // The fee is charged on top, so exactly-the-budget is not enough — and the
    // number they need is the total, not a shortfall against a figure they
    // never entered.
    workerBalance.mockResolvedValue("5.00");

    await expect(commissionAsWorker(GOOD)).rejects.toThrow(/5\.125 USDC/);
    expect(createEscrow).not.toHaveBeenCalled();
  });

  it("says what they hold, so the sentence is actionable", async () => {
    workerBalance.mockResolvedValue("1.02");
    await expect(commissionAsWorker(GOOD)).rejects.toThrow(/holds 1\.02/);
  });

  it("refuses milestones that do not add up to the budget", async () => {
    // createEscrow rejects this outright; a revert is the expensive way to learn it.
    await expect(
      commissionAsWorker({ ...GOOD, milestones: [{ description: "All of it", amount: 4 }] }),
    ).rejects.toThrow(/add up to 4 USDC but the budget is 5/);
    expect(createEscrow).not.toHaveBeenCalled();
  });

  it("compares in base units, so a job funded to the cent does not fail on the cent", async () => {
    // 0.1 + 0.2 !== 0.3 in float. It does in integer base units.
    quoteDeposit.mockResolvedValue({ deposit: 310_000n, fee: 10_000n });
    await expect(
      commissionAsWorker({
        ...GOOD,
        budgetUsdc: 0.3,
        milestones: [
          { description: "First", amount: 0.1 },
          { description: "Second", amount: 0.2 },
        ],
      }),
    ).resolves.toMatchObject({ escrowId: "12" });
  });

  it("refuses a job with no real milestones", async () => {
    await expect(
      commissionAsWorker({ ...GOOD, milestones: [{ description: "   ", amount: 5 }] }),
    ).rejects.toThrow(/at least one milestone/i);
  });

  it("will not sign for somebody who brought their own keys", async () => {
    getWorker.mockReturnValue({ id: "w1", walletAddress: ME, mode: "own" });

    await expect(commissionAsWorker(GOOD)).rejects.toThrow(/can't sign for you/i);
    expect(createEscrow).not.toHaveBeenCalled();
  });

  it("tops up gas before asking them to sign", async () => {
    await commissionAsWorker(GOOD);
    expect(dripGas).toHaveBeenCalledWith(ME);
  });
});

describe("when the funding transaction fails", () => {
  it("does not leave a ghost sitting in 'briefing' forever", async () => {
    // Six of those piled up once, and the stats bar counted every one as work
    // in progress that nobody was doing.
    createEscrow.mockRejectedValue(new Error("insufficient funds"));

    await expect(commissionAsWorker(GOOD)).rejects.toThrow(/insufficient funds/);
    expect(updateTaskStatus).toHaveBeenCalledWith(expect.any(String), "failed", undefined);
  });
});


/**
 * FUNDED AND UNMANAGED IS A JOB WEARING THE WRONG LABEL.
 *
 * The browser flow had exactly this bug once: the escrow was created and
 * nothing else happened, so an "Autopilot" job came out byte-identical to a
 * manual one and the agent never looked at it. The mode the client chose
 * existed only in which page they had been on.
 *
 * It has to be a second transaction, because an escrow must exist before it can
 * have a manager — which means it can fail on its own, after the money is
 * already safe.
 */
describe("handing it to Autopilot", () => {
  it("delegates to the agent, signed by the worker who owns the job", async () => {
    await commissionAsWorker({ ...GOOD, handToAutopilot: true });

    expect(setJobManager).toHaveBeenCalledWith(12n, AGENT, { address: ME });
  });

  it("leaves it manual when that is what was asked for", async () => {
    await commissionAsWorker({ ...GOOD, handToAutopilot: false });
    expect(setJobManager).not.toHaveBeenCalled();
  });

  it("still reports the job as posted when only the hand-over failed", async () => {
    // The money is already safe. Reporting this as a failure to post would send
    // somebody looking for a refund on an escrow that exists and is funded.
    setJobManager.mockRejectedValue(new Error("rate limit exceeded"));

    await expect(commissionAsWorker({ ...GOOD, handToAutopilot: true })).resolves.toMatchObject({
      escrowId: "12",
      handedOver: false,
    });
  });
});


/**
 * THE YIELD TERM, WRITTEN WHILE NOBODY IS RELYING ON IT.
 *
 * The browser flow has always offered this and the agent endpoint silently
 * skipped it — escrow 9, posted through the new route, came out with no choice
 * made at all while 7 and 8 were both opted in.
 *
 * Opting in only ever moves in the poster's favour and the freelancer's: the
 * platform fee is waived, so they approve less today, and 60% of anything
 * earned goes to whoever does the work. So it defaults on. It stays a parameter
 * rather than a constant because the contract is emphatic that this is the
 * depositor's call, and it can never be changed once given.
 */
describe("putting the escrow to work", () => {
  it("opts in by default, signed by the depositor", async () => {
    await commissionAsWorker(GOOD);

    expect(setYieldOptIn).toHaveBeenCalledWith(12n, true, { address: ME });
  });

  it("can be declined", async () => {
    await commissionAsWorker({ ...GOOD, putToWork: false });
    expect(setYieldOptIn).not.toHaveBeenCalled();
  });

  it("writes the term BEFORE handing the job over", async () => {
    // The window closes when work starts, and the agent starts collecting
    // applications the moment it is manager. Order is the whole guarantee.
    const order: string[] = [];
    setYieldOptIn.mockImplementation(async () => void order.push("yield"));
    setJobManager.mockImplementation(async () => void order.push("handover"));

    await commissionAsWorker({ ...GOOD, handToAutopilot: true });

    expect(order).toEqual(["yield", "handover"]);
  });

  it("still reports the job posted when only the term failed", async () => {
    // The money is safe. A term that only ever improves the job is not worth
    // failing a funded commission over.
    setYieldOptIn.mockRejectedValue(new Error("no controller attached"));

    await expect(commissionAsWorker(GOOD)).resolves.toMatchObject({
      escrowId: "12",
      earning: false,
    });
  });
});
