import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BOTH DOORS SHOW THE SAME MARKETPLACE.
 *
 * The Telegram board read the daemon's own task table and nothing else, so a
 * freelancer in the bot saw only jobs THIS agent had posted or adopted. A job
 * commissioned by another agent, run manually by its client, or managed by a
 * different deployment of this same daemon was open, funded, and invisible —
 * while the web board, reading the chain, listed it.
 *
 * It showed up as "No open commissions this minute" in the bot at the same
 * moment the web app showed two funded jobs. Nothing was down; the two surfaces
 * were reading different things.
 */

const listTasks = vi.fn(() => [] as any[]);
const openEscrows = vi.fn();

vi.mock("../src/store.js", () => ({
  listTasks: (n?: number) => listTasks(n),
  getWorker: () => null,
  listDecisions: () => [],
  getPollerText: () => null,
  setPollerText: () => {},
  hiredFor: () => null,
  getWorkerByAddress: () => null,
  listWorkers: () => [],
}));

vi.mock("../src/web3/atelier.js", () => ({
  openEscrows: () => openEscrows(),
  hiredEscrowsFor: vi.fn(),
  hasApplied: vi.fn(),
  getEscrow: vi.fn(),
  getMilestones: vi.fn(),
  jobManagerOf: vi.fn(),
}));

vi.mock("../src/agent/handover.js", () => ({ criteriaFor: () => ({ criteria: [], source: "none" }), previewCriteria: vi.fn() }));
vi.mock("../src/config.js", () => ({ config: { applicationWindowMinutes: 3 } }));
vi.mock("../src/graph/client.js", () => ({ graphQuery: vi.fn(), isGraphConfigured: () => false }));

const { openQuests, ownQuests } = await import("../src/workers/service.js");

/** A job this agent posted, so it holds the brief. */
const OWN_TASK = {
  escrowId: "9",
  status: "posted",
  instruction: "A one-pager",
  briefJson: JSON.stringify({
    title: "Atelier one-pager", budget: 0.5, durationDays: 2,
    criteria: ["Plain language"], milestones: [{ description: "The page", amount: 0.5 }],
  }),
  createdAt: Date.now(),
};

/** A job somebody else's agent posted. Open, funded, not in our table. */
const SOMEBODY_ELSES = {
  escrowId: 8n,
  title: "mytube",
  description: "[category:development] A dashboard",
  totalAmount: 9_000_000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  milestones: [{ description: "The dashboard", amount: 9_000_000n }],
};

beforeEach(() => {
  vi.clearAllMocks();
  listTasks.mockReturnValue([OWN_TASK]);
  openEscrows.mockResolvedValue([SOMEBODY_ELSES]);
});

describe("the open board", () => {
  it("lists a job this agent never posted", async () => {
    const board = await openQuests();
    expect(board.map((q) => q.escrowId).sort()).toEqual(["8", "9"]);
  });

  it("describes it from the escrow's own title and stages", async () => {
    const [, other] = await openQuests();
    expect(other.title).toBe("mytube");
    expect(other.budget).toBe(9);
    expect(other.milestones).toEqual([{ description: "The dashboard", amount: 9 }]);
  });

  it("does not invent acceptance criteria for a job it holds no brief for", async () => {
    // Criteria are what a freelancer is judged against. Making them up is worse
    // than leaving them out.
    const [, other] = await openQuests();
    expect(other.criteria).toEqual([]);
  });

  it("keeps the agent's own brief where it has one", async () => {
    const [own] = await openQuests();
    expect(own.criteria).toEqual(["Plain language"]);
  });

  it("does not list the same job twice when the agent also holds it", async () => {
    openEscrows.mockResolvedValue([{ ...SOMEBODY_ELSES, escrowId: 9n, title: "from chain" }]);

    const board = await openQuests();
    expect(board).toHaveLength(1);
    expect(board[0].title).toBe("Atelier one-pager"); // the brief wins
  });

  it("still shows the agent's own jobs when the chain will not answer", async () => {
    // Degrade the board, never empty it.
    openEscrows.mockRejectedValue(new Error("rate limit exceeded"));

    const board = await openQuests();
    expect(board.map((q) => q.escrowId)).toEqual(["9"]);
  });

  it("shows somebody else's jobs even when this agent has none of its own", async () => {
    // Exactly the reported case: "No open commissions this minute" from a bot
    // whose daemon had adopted nothing, while two funded jobs sat on chain.
    listTasks.mockReturnValue([]);

    const board = await openQuests();
    expect(board.map((q) => q.escrowId)).toEqual(["8"]);
  });

  it("leaves ownQuests reading only the agent's own table", async () => {
    // The poller uses it on every sweep and must not pay for a chain read.
    expect(ownQuests().map((q) => q.escrowId)).toEqual(["9"]);
    expect(openEscrows).not.toHaveBeenCalled();
  });
});
