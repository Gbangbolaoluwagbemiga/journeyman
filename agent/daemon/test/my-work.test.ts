import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHAT WORK IS MINE — answered by the chain, not by the daemon's memory.
 *
 * A client hired a freelancer themselves from the app, then took the job back
 * off Autopilot. Two things followed, and together they made a funded job
 * invisible to the only person who could do it:
 *
 *   revoking deleted the task row, and the board listed only task rows
 *   "hired" was read from the agent's own applicant_accepted decisions, and
 *   a client hiring by hand never produces one
 *
 * So the freelancer was the named beneficiary of a funded escrow, owed the
 * work, and had an empty board — while the client's screen showed the job
 * assigned to them. FreelancerAccepted is indexed on the freelancer, so the
 * chain can answer this directly for every hire, whoever made it.
 */

const ME = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";

const getWorker = vi.fn();
const listTasks = vi.fn(() => [] as any[]);
const listDecisions = vi.fn(() => [] as any[]);
const hiredEscrowsFor = vi.fn();
const hasApplied = vi.fn();
const getEscrow = vi.fn();
const getMilestones = vi.fn();
const jobManagerOf = vi.fn();

vi.mock("../src/store.js", () => ({
  getWorker: (id: string) => getWorker(id),
  listTasks: (n?: number) => listTasks(n),
  listDecisions: (n?: number) => listDecisions(n),
  getPollerText: () => null,
  setPollerText: () => {},
  hiredFor: () => null,
  getWorkerByAddress: () => null,
  listWorkers: () => [],
}));

vi.mock("../src/web3/atelier.js", () => ({
  hiredEscrowsFor: (a: string) => hiredEscrowsFor(a),
  hasApplied: (id: bigint, a: string) => hasApplied(id, a),
  getEscrow: (id: bigint) => getEscrow(id),
  getMilestones: (id: bigint) => getMilestones(id),
  jobManagerOf: (id: bigint) => jobManagerOf(id),
}));

/* service.ts reads a job's criteria through handover, which imports the brief
   generator and therefore the Groq client. Nothing here needs a model. */
vi.mock("../src/agent/handover.js", () => ({
  criteriaFor: () => ({ criteria: [], source: "none" }),
}));

vi.mock("../src/config.js", () => ({ config: { applicationWindowMinutes: 3 } }));
const graphQuery = vi.fn();
const isGraphConfigured = vi.fn(() => false);
vi.mock("../src/graph/client.js", () => ({
  graphQuery: (...a: unknown[]) => graphQuery(...a),
  isGraphConfigured: () => isGraphConfigured(),
}));

const { myWork } = await import("../src/workers/service.js");

beforeEach(() => {
  vi.clearAllMocks();
  getWorker.mockReturnValue({ id: "w1", walletAddress: ME });
  listTasks.mockReturnValue([]);
  listDecisions.mockReturnValue([]);
  hiredEscrowsFor.mockResolvedValue([]);
  hasApplied.mockResolvedValue(false);
  getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 5_000_000n, status: 0 });
  getMilestones.mockResolvedValue([{ status: 0 }, { status: 0 }]);
  jobManagerOf.mockResolvedValue(null);
  isGraphConfigured.mockReturnValue(false);
  graphQuery.mockRejectedValue(new Error("GraphQL HTTP 429"));
});

describe("a job the client hired for by hand", () => {
  it("is listed even though the daemon has no task for it", async () => {
    // Exactly escrow 7: hired on-chain, Autopilot revoked, task row deleted.
    hiredEscrowsFor.mockResolvedValue([7n]);

    const work = await myWork("w1");

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ escrowId: "7", title: "fireball", budget: 5, state: "hired" });
    expect(work[0].status).toMatch(/send your work/i);
  });

  it("is counted as hired without an applicant_accepted decision", async () => {
    // The agent never hired anyone here — it scored the applicant 25/100 and
    // declined. The client hired them anyway. That is still being hired.
    hiredEscrowsFor.mockResolvedValue([7n]);
    listDecisions.mockReturnValue([]);

    expect((await myWork("w1"))[0].state).toBe("hired");
  });

  it("stops telling them to send work once the job has paid out", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 5_000_000n, status: 3 });

    expect((await myWork("w1"))[0].state).toBe("completed");
  });

  it("shows a disputed job as being with an arbiter", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 5_000_000n, status: 4 });

    expect((await myWork("w1"))[0].state).toBe("disputed");
  });
});

describe("what it still gets from the agent's own records", () => {
  it("prefers the brief's title and budget when the agent is running the job", async () => {
    // The brief is richer than the escrow, and it is what the agent works from.
    hiredEscrowsFor.mockResolvedValue([7n]);
    listTasks.mockReturnValue([
      { escrowId: "7", status: "active", briefJson: JSON.stringify({ title: "Fireball art", budget: 5 }) },
    ]);

    expect((await myWork("w1"))[0].title).toBe("Fireball art");
  });

  it("still lists a job applied to but not won", async () => {
    listTasks.mockReturnValue([
      { escrowId: "9", status: "posted", briefJson: JSON.stringify({ title: "Other job", budget: 2 }) },
    ]);
    hasApplied.mockResolvedValue(true);

    expect((await myWork("w1"))[0].state).toBe("applied");
  });

  it("does not list a job with no connection to this worker", async () => {
    listTasks.mockReturnValue([
      { escrowId: "9", status: "posted", briefJson: JSON.stringify({ title: "Someone else's", budget: 2 }) },
    ]);
    expect(await myWork("w1")).toEqual([]);
  });

  it("never lists the same escrow twice when both sources know it", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    listTasks.mockReturnValue([
      { escrowId: "7", status: "active", briefJson: JSON.stringify({ title: "fireball", budget: 5 }) },
    ]);
    expect(await myWork("w1")).toHaveLength(1);
  });
});

describe("when the chain will not answer", () => {
  it("still lists what the agent knows rather than returning nothing", async () => {
    // An RPC outage must not empty somebody's board.
    hiredEscrowsFor.mockRejectedValue(new Error("rpc down"));
    listTasks.mockReturnValue([
      { escrowId: "9", status: "posted", briefJson: JSON.stringify({ title: "Other job", budget: 2 }) },
    ]);
    hasApplied.mockResolvedValue(true);

    expect((await myWork("w1"))[0].escrowId).toBe("9");
  });

  it("hides a row it cannot describe instead of rendering a blank one", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getEscrow.mockRejectedValue(new Error("rpc down"));

    expect(await myWork("w1")).toEqual([]);
  });
});


/**
 * WHAT HAPPENED TO WHAT I ALREADY SENT.
 *
 * The row read "You were hired — send your work" from the moment of hire until
 * the job closed, whatever had been delivered. Somebody submitted a milestone,
 * saw the same sentence and the same button, and sent the next stage with no
 * idea whether the first had been looked at. Two deliveries, one made blind.
 */
describe("a job with work already delivered", () => {
  it("holds the next stage while one is still with the reviewer", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 1 }, { status: 0 }]); // 1 = submitted

    const [row] = await myWork("w1");

    expect(row.awaitingReview).toBe(1);
    expect(row.status).toMatch(/with the reviewer/i);
    // One delivery at a time. Otherwise somebody sends two stages without ever
    // receiving a verdict on the first.
    expect(row.canSubmit).toBe(false);
  });

  it("asks again, with the reason, when a stage is sent back", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 3 }, { status: 0 }]); // 3 = rejected

    const [row] = await myWork("w1");

    expect(row.needsRevision).toBe(1);
    expect(row.status).toMatch(/changes requested/i);
    // A rejected stage is exactly what they are being asked to send again.
    expect(row.canSubmit).toBe(true);
  });

  it("says whether a machine or a person will decide", async () => {
    // A freelancer waiting on a verdict cannot tell an agent that answers in
    // minutes from a client who answers when they next open the tab. Both look
    // like silence.
    hiredEscrowsFor.mockResolvedValue([7n]);
    jobManagerOf.mockResolvedValue("0x6073dfbf2dbd479f87afd5683eaf02d8ad9bf308");

    expect((await myWork("w1"))[0].reviewer).toBe("agent");

    jobManagerOf.mockResolvedValue(null);
    expect((await myWork("w1"))[0].reviewer).toBe("client");
  });

  it("stops offering the button when every stage is delivered", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 1 }, { status: 1 }]);

    const [row] = await myWork("w1");

    expect(row.canSubmit).toBe(false);
    expect(row.status).toMatch(/waiting on review/i);
  });

  it("counts what has actually been paid, and asks for the rest", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 2 }, { status: 0 }]); // 2 = approved

    const [row] = await myWork("w1");

    expect(row.approved).toBe(1);
    expect(row.status).toMatch(/1 of 2 approved and paid/i);
    expect(row.canSubmit).toBe(true);
  });

  it("nothing left to send once all stages are approved", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 2 }, { status: 2 }]);

    expect((await myWork("w1"))[0].canSubmit).toBe(false);
  });

  it("withholds the button when the chain will not say", async () => {
    /*
     * REVERSED, DELIBERATELY.
     *
     * This used to assert the opposite — offer the button, on the reasoning
     * that "unknown must not mean you are finished, that would strand a
     * delivery". Both readings of unknown are wrong; the question is which
     * wrong is worse, and that got answered in use.
     *
     * Escrow 7 was delivered in full and paid. One rate-limited request later,
     * its owner's board said "You were hired — send your work" with the button
     * live. Asking somebody to redo work they have already been paid for is a
     * real cost to them; a submission on a stage the daemon cannot count would
     * not have landed correctly anyway.
     *
     * The other way round, the cost is a short wait. The row says the stages
     * could not be read and the board re-polls, so a genuinely-hired freelancer
     * gets the button back within seconds rather than being told to do work
     * twice.
     */
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockRejectedValue(new Error("rpc down"));

    const [row] = await myWork("w1");
    expect(row.canSubmit).toBe(false);
    expect(row.stagesKnown).toBe(false);
    // The job is still listed, and says which part failed.
    expect(row.status).toMatch(/could not read/i);
  });
});


/**
 * FINISHED MEANS EVERY STAGE IS APPROVED — not that the escrow says so.
 *
 * The state was read off the escrow's own status, and an escrow whose
 * milestones are all approved and fully paid can still sit at "Submitted".
 * Escrow 7 did, after a dispute was resolved — so somebody who had delivered
 * everything and been paid was shown "in progress", on a bench with nothing on
 * it, above a row inviting them to send a stage that does not exist.
 */
describe("a job where every stage is approved", () => {
  it("is finished, whatever the escrow's own status has caught up to", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 2 }, { status: 2 }]);
    // 2 = Submitted, exactly what escrow 7 reads after its dispute resolved.
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 3_000_000n, status: 2 });

    const [row] = await myWork("w1");

    expect(row.state).toBe("completed");
    expect(row.status).toMatch(/approved and paid/i);
    expect(row.canSubmit).toBe(false);
  });

  it("never invites a next stage when there is not one", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 2 }, { status: 2 }]);

    expect((await myWork("w1"))[0].status).not.toMatch(/send the next stage/i);
  });

  it("still asks for the next stage when one is genuinely left", async () => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getMilestones.mockResolvedValue([{ status: 2 }, { status: 0 }]);

    const [row] = await myWork("w1");
    expect(row.state).toBe("hired");
    expect(row.status).toMatch(/send the next stage/i);
  });
});

/**
 * AN EMPTY BOARD HAS TO BE EARNED.
 *
 * The hire list used to end in `.catch(() => [])`, so a rate-limited subgraph
 * and a refusing RPC together produced an empty array — and a freelancer's
 * finished job vanished off their board with nothing to say anything had gone
 * wrong. "Nobody answered" and "you have no work" looked identical, which is
 * the third time that shape of bug has cost a day here.
 */
describe("when no source can answer", () => {
  it("fails rather than claiming the bench is empty", async () => {
    hiredEscrowsFor.mockRejectedValue(new Error("rate limit exceeded"));
    listTasks.mockReturnValue([]);

    await expect(myWork("w1")).rejects.toThrow(/read problem/i);
  });

  it("fails rather than dropping every task row it cannot ask about", async () => {
    /*
     * The narrower guard above only covers a daemon holding no task rows. With
     * task rows and an unreachable chain, each candidate fell through to
     * hasApplied, each of those failed, each became "not involved", and the loop
     * dropped all of them — an empty board returned as a 200, directly under the
     * log line saying nothing could list hires. Caught while verifying the fix
     * for the narrower version of itself.
     */
    hiredEscrowsFor.mockRejectedValue(new Error("rate limit exceeded"));
    listTasks.mockReturnValue([
      { escrowId: "9", status: "posted", briefJson: JSON.stringify({ title: "Other job", budget: 2 }) },
    ]);
    hasApplied.mockRejectedValue(new Error("rate limit exceeded"));

    await expect(myWork("w1")).rejects.toThrow(/read problem/i);
  });

  it("still renders what the daemon knows when only the chain is down", async () => {
    // A partial answer is worth showing. Silence is not.
    hiredEscrowsFor.mockRejectedValue(new Error("rate limit exceeded"));
    listTasks.mockReturnValue([
      { escrowId: "9", status: "posted", briefJson: JSON.stringify({ title: "Other job", budget: 2 }) },
    ]);
    hasApplied.mockResolvedValue(true);

    const work = await myWork("w1");
    expect(work[0].escrowId).toBe("9");
  });

  it("renders an empty bench happily when a source genuinely said so", async () => {
    hiredEscrowsFor.mockResolvedValue([]);
    listTasks.mockReturnValue([]);

    await expect(myWork("w1")).resolves.toEqual([]);
  });
});

/**
 * ZERO STAGES AND UNREAD STAGES ARE NOT THE SAME NUMBER.
 *
 * The milestone read has always had a catch around it, described as leaving the
 * row "without a stage summary, not missing". Everything downstream then read
 * that absence through `?? 0` — and zero is a claim: nothing approved, nothing
 * awaiting, so there must be something to send.
 *
 * Escrow 7 was finished and paid in full. One rate-limited request later, its
 * owner's board read "You were hired — send your work" with the button live.
 * Asking somebody to redo work they have already been paid for is worse than
 * showing them nothing at all.
 */
describe("when the stages cannot be read", () => {
  beforeEach(() => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 3_000_000n, status: 1 });
    getMilestones.mockRejectedValue(new Error("rate limit exceeded"));
  });

  it("does not invite a delivery it cannot justify", async () => {
    const [row] = await myWork("w1");
    expect(row.canSubmit).toBe(false);
  });

  it("says the stages could not be read, not 'send your work'", async () => {
    const [row] = await myWork("w1");
    expect(row.status).not.toMatch(/send your work/i);
    expect(row.status).toMatch(/could not read/i);
  });

  it("marks the counts as unread rather than presenting them as figures", async () => {
    const [row] = await myWork("w1");
    expect(row.stagesKnown).toBe(false);
  });

  it("still lists the job — the row is degraded, not dropped", async () => {
    const [row] = await myWork("w1");
    expect(row.escrowId).toBe("7");
    expect(row.title).toBe("fireball");
  });

  it("keeps saying finished when the escrow itself settled", async () => {
    // The escrow released: that is a chain fact and needs no milestone read.
    const RELEASED = 3;
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 3_000_000n, status: RELEASED });

    const [row] = await myWork("w1");
    expect(row.state).toBe("completed");
    expect(row.canSubmit).toBe(false);
  });

  it("still offers a delivery on a genuinely fresh hire", async () => {
    // The counts read fine and say nothing has been done — that IS an answer.
    getMilestones.mockResolvedValue([{ status: 0 }, { status: 0 }]);

    const [row] = await myWork("w1");
    expect(row.stagesKnown).toBe(true);
    expect(row.canSubmit).toBe(true);
    expect(row.status).toMatch(/send your work/i);
  });
});

/**
 * "APPROVED" ON CHAIN DOES NOT MEAN THE WORK WAS ACCEPTED.
 *
 * `resolveDispute` sets `m.status = MilestoneStatus.Approved` whoever won. The
 * contract uses Approved to mean "settled" and records who got the money in
 * `resolutionFreelancerAmount` / `resolutionClientAmount`.
 *
 * Reading the status alone, escrow 7 looked finished and fully paid. What
 * actually happened: stage one approved for 3 USDC, stage two disputed, taken
 * off the freelancer by an arbiter, and 2 USDC returned to the client. Their
 * board said "All 2 stage(s) approved and paid" and their dashboard counted a
 * job "paid in full". They earned 3 of 5 and were congratulated on 5.
 *
 * Wrong in the freelancer's favour is still wrong, and it is the direction that
 * gets noticed last.
 */
describe("a stage an arbiter took off the freelancer", () => {
  /** Escrow 7 exactly as the chain reports it. */
  const ESCROW_7 = [
    {
      status: 2, amount: 3_000_000n, resolvedAt: 0n,
      resolutionFreelancerAmount: 0n, resolutionClientAmount: 0n,
    },
    {
      status: 2, amount: 2_000_000n, resolvedAt: 1_789_131_680n,
      resolutionFreelancerAmount: 0n, resolutionClientAmount: 2_000_000n,
    },
  ];

  beforeEach(() => {
    hiredEscrowsFor.mockResolvedValue([7n]);
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 3_000_000n, status: 2 });
    getMilestones.mockResolvedValue(ESCROW_7);
  });

  it("does not count it as approved work", async () => {
    const [row] = await myWork("w1");
    expect(row.approved).toBe(1);
    expect(row.arbitrated).toBe(1);
  });

  it("does not tell them every stage was approved and paid", async () => {
    const [row] = await myWork("w1");
    expect(row.status).not.toMatch(/all 2 stage/i);
    expect(row.status).not.toMatch(/approved and paid$/i);
  });

  it("says an arbiter settled it", async () => {
    const [row] = await myWork("w1");
    expect(row.status).toMatch(/arbiter/i);
  });

  it("reports what actually reached them, not the job's face value", async () => {
    const [row] = await myWork("w1");
    expect(row.earnedUsdc).toBe(3);
  });

  it("still treats the job as over — there is nothing left to send", async () => {
    const [row] = await myWork("w1");
    expect(row.state).toBe("completed");
    expect(row.canSubmit).toBe(false);
  });

  it("keeps saying paid in full when every stage really was approved", async () => {
    getMilestones.mockResolvedValue([
      { status: 2, amount: 3_000_000n, resolvedAt: 0n, resolutionFreelancerAmount: 0n, resolutionClientAmount: 0n },
      { status: 2, amount: 2_000_000n, resolvedAt: 0n, resolutionFreelancerAmount: 0n, resolutionClientAmount: 0n },
    ]);

    const [row] = await myWork("w1");
    expect(row.arbitrated).toBe(0);
    expect(row.status).toMatch(/All 2 stage\(s\) approved and paid/i);
    expect(row.earnedUsdc).toBe(5);
  });

  it("credits an arbiter's split when it went the freelancer's way", async () => {
    // The same read has to work when the arbiter awards them part of it.
    getMilestones.mockResolvedValue([
      { status: 2, amount: 3_000_000n, resolvedAt: 0n, resolutionFreelancerAmount: 0n, resolutionClientAmount: 0n },
      { status: 2, amount: 2_000_000n, resolvedAt: 1n, resolutionFreelancerAmount: 1_500_000n, resolutionClientAmount: 500_000n },
    ]);

    const [row] = await myWork("w1");
    expect(row.earnedUsdc).toBe(4.5);
    expect(row.status).toMatch(/\$4\.50 of \$5\.00/);
  });

  it("does not count a settled stage as one still waiting for work", async () => {
    // Mid-job: stage one settled by an arbiter, stage two untouched.
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 5_000_000n, status: 1 });
    getMilestones.mockResolvedValue([
      { status: 2, amount: 3_000_000n, resolvedAt: 1n, resolutionFreelancerAmount: 1_000_000n, resolutionClientAmount: 2_000_000n },
      { status: 0, amount: 2_000_000n, resolvedAt: 0n, resolutionFreelancerAmount: 0n, resolutionClientAmount: 0n },
    ]);

    const [row] = await myWork("w1");
    expect(row.state).toBe("hired");
    expect(row.canSubmit).toBe(true);
    expect(row.status).toMatch(/0 of 2 approved, 1 settled by an arbiter/i);
  });
});

/**
 * AN INDEX SAYING "NONE" IS NOT THE CHAIN SAYING "NONE".
 *
 * The subgraph was asked first and believed absolutely. A non-empty list is
 * trustworthy — it found real hires, which is the whole reason it is faster
 * than walking the chain. An empty list is the one answer a lagging index
 * produces that looks exactly like the truth.
 *
 * Subgraph Studio rate-limits this project under ordinary use ("Too many
 * requests", in plain text, not even JSON), and an index that is behind or
 * re-syncing returns no escrows with a perfectly valid 200. So a freelancer's
 * finished job blinked off their board about one poll in six, while the chain —
 * asked in the same second — listed it without hesitating.
 */
describe("when the index says you have never been hired", () => {
  beforeEach(() => {
    isGraphConfigured.mockReturnValue(true);
    getEscrow.mockResolvedValue({ projectTitle: "fireball", totalAmount: 3_000_000n, status: 2 });
    getMilestones.mockResolvedValue([{ status: 2, amount: 3_000_000n, resolvedAt: 0n }]);
  });

  it("asks the chain before believing it", async () => {
    graphQuery.mockResolvedValue({ escrows: [] });
    hiredEscrowsFor.mockResolvedValue([7n]);

    const work = await myWork("w1");

    expect(hiredEscrowsFor).toHaveBeenCalled();
    expect(work.map((w) => w.escrowId)).toEqual(["7"]);
  });

  it("takes the index at its word when it actually found something", async () => {
    // Confirming a non-empty answer would spend a chain read to learn nothing —
    // the index cannot invent a hire, only miss one.
    graphQuery.mockResolvedValue({ escrows: [{ escrowId: "7" }] });

    const work = await myWork("w1");

    expect(hiredEscrowsFor).not.toHaveBeenCalled();
    expect(work.map((w) => w.escrowId)).toEqual(["7"]);
  });

  it("reports an empty bench when BOTH sources agree there is nothing", async () => {
    graphQuery.mockResolvedValue({ escrows: [] });
    hiredEscrowsFor.mockResolvedValue([]);
    listTasks.mockReturnValue([]);

    await expect(myWork("w1")).resolves.toEqual([]);
  });

  it("refuses to answer when the index says none and the chain cannot be reached", async () => {
    graphQuery.mockResolvedValue({ escrows: [] });
    hiredEscrowsFor.mockRejectedValue(new Error("rate limit exceeded"));
    listTasks.mockReturnValue([]);

    await expect(myWork("w1")).rejects.toThrow(/read problem/i);
  });
});
