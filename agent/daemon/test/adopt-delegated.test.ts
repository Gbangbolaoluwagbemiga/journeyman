import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PICKING UP A JOB A CLIENT HANDED OVER IN THE APP — AND PUTTING IT BACK DOWN.
 *
 * The delegation was real on-chain and completely inert for weeks: the app said
 * "Autopilot is running this job", the contract would have allowed it, and the
 * poller never looked because it only iterates its own task table. A client sat
 * watching an agent that had never heard of their job.
 *
 * Three things here have each already cost something real:
 *
 *   a revoked manager keeps its log forever, so the event is not the answer
 *   a job already in progress is a legitimate hand-off, not one to ignore
 *   every number comes from the escrow, never from the client's prose
 *
 * The last one shipped. The bot advertised a $50 job paying $10 and $40 while
 * the contract held 5 USDC split 1 and 4, because the description said "Budget
 * $50" and the brief was regenerated from the description.
 */

const AGENT = "0x000000000000000000000000000000000000A6E7";
const CLIENT = "0x1111111111111111111111111111111111111111";

const readContract = vi.fn();
const getBlockNumber = vi.fn(async () => 100n);
const getLogs = vi.fn(async () => [] as unknown[]);
const insertTask = vi.fn();
const deleteTask = vi.fn();
const listTasks = vi.fn(() => [] as any[]);
const generateBrief = vi.fn();

vi.mock("../src/web3/atelier.js", () => ({
  /* Reads and logs go to different endpoints now — drpc answers reads and caps
     a log range under 200 blocks; the Arc RPC is the only one that will walk a
     real range. Same fakes behind both here: this suite is about what the sweep
     decides, not about which host answered. */
  getPublicClient: () => ({ readContract, getBlockNumber, getLogs }),
  getLogClient: () => ({ readContract, getBlockNumber, getLogs }),
}));
vi.mock("../src/circle/circleSigner.js", () => ({
  createCircleSigner: () => ({ address: AGENT }),
}));
const getPollerText = vi.fn(() => null as string | null);
const setPollerText = vi.fn();
/* The sweep remembers how far it has read, so it does not rescan 780,000
   blocks every fifteen seconds and rate-limit itself into finding nothing. */
const getPollerInt = vi.fn(() => null as number | null);
const setPollerInt = vi.fn();
vi.mock("../src/store.js", () => ({
  insertTask, deleteTask, listTasks,
  getPollerText, setPollerText, getPollerInt, setPollerInt,
}));
vi.mock("../src/agent/BriefGenerator.js", () => ({ generateBrief }));
vi.mock("../src/config.js", () => ({
  config: {
    atelierAddress: "0x00000000000000000000000000000000000A7E11",
    atelierDeployBlock: 0n,
    logRangeLimit: 50n,
  },
}));

const { adoptDelegatedJobs } = await import("../src/agent/adoptDelegated.js");

const PENDING = 0, IN_PROGRESS = 1, RELEASED = 3;

function escrow(over: Record<string, unknown> = {}) {
  return {
    depositor: CLIENT,
    beneficiary: "0x0000000000000000000000000000000000000000",
    totalAmount: 5_000_000n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3 * 86400),
    status: PENDING,
    isOpenJob: true,
    projectTitle: "Coffee Roastery Logo",
    projectDescription: "A logo for a coffee roastery. Budget $50, 3 days.",
    ...over,
  };
}

/** The chain answers: we manage escrow 7, and it looks like `esc`. */
function chainSays(opts: { manager?: string; esc?: Record<string, unknown>; milestones?: any[] } = {}) {
  getLogs.mockResolvedValue([{ args: { escrowId: 7n } }]);
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "jobManager") return opts.manager ?? AGENT;
    if (functionName === "getEscrow") return escrow(opts.esc);
    if (functionName === "getMilestones")
      return opts.milestones ?? [
        { amount: 1_000_000n, requirements: "Concepts", description: "" },
        { amount: 4_000_000n, requirements: "Final files", description: "" },
      ];
    throw new Error(`unexpected read: ${functionName}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getBlockNumber.mockResolvedValue(100n);
  getLogs.mockResolvedValue([]);
  listTasks.mockReturnValue([]);
  generateBrief.mockResolvedValue({
    brief: { title: "Logo", budget: 50, durationDays: 3, criteria: ["vector"], milestones: [{ description: "All of it", amount: 50 }] },
  });
});

describe("finding what is ours", () => {
  it("adopts an escrow that names us as manager", async () => {
    chainSays();
    expect(await adoptDelegatedJobs()).toBe(1);
    expect(insertTask).toHaveBeenCalledOnce();
    expect(insertTask.mock.calls[0][0]).toMatchObject({ id: "delegated-7", escrowId: "7", clientAddress: CLIENT });
  });

  /* The event says we were appointed once. The mapping says whether we still
     are, and acting on the log alone is the agent working a job the client
     already took back. */
  it("ignores an escrow whose manager was revoked", async () => {
    chainSays({ manager: "0x0000000000000000000000000000000000000000" });
    expect(await adoptDelegatedJobs()).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it("ignores an escrow handed to a different manager", async () => {
    chainSays({ manager: "0x9999999999999999999999999999999999999999" });
    expect(await adoptDelegatedJobs()).toBe(0);
  });

  it("does not adopt the same job twice", async () => {
    chainSays();
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    expect(await adoptDelegatedJobs()).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it("windows the log scan, because the RPC refuses a wide range", async () => {
    chainSays();
    await adoptDelegatedJobs();
    // 0–100 at a 50-block limit is three windows, never one call for the lot.
    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    for (const [args] of getLogs.mock.calls) {
      expect(Number(args.toBlock) - Number(args.fromBlock)).toBeLessThanOrEqual(50);
    }
  });
});

describe("which jobs are worth taking", () => {
  it("takes one with a freelancer already working, and goes straight to reviewing", async () => {
    chainSays({ esc: { status: IN_PROGRESS, beneficiary: "0x2222222222222222222222222222222222222222" } });
    expect(await adoptDelegatedJobs()).toBe(1);
    expect(insertTask.mock.calls[0][0].status).toBe("active");
  });

  it("posts a job with nobody hired yet", async () => {
    chainSays();
    await adoptDelegatedJobs();
    expect(insertTask.mock.calls[0][0].status).toBe("posted");
  });

  it("leaves a settled job alone — there is nothing left to decide", async () => {
    chainSays({ esc: { status: RELEASED } });
    expect(await adoptDelegatedJobs()).toBe(0);
  });
});

/**
 * The shipped bug. A client routinely edits the milestones before funding, so
 * the prose and the contract disagree — and only one of them can pay anyone.
 */
describe("what the job is worth", () => {
  it("takes every number from the escrow, not the client's description", async () => {
    chainSays();
    await adoptDelegatedJobs();

    const brief = JSON.parse(insertTask.mock.calls[0][0].briefJson);
    expect(brief.budget).toBe(5);
    expect(brief.milestones).toEqual([
      { description: "Concepts", amount: 1 },
      { description: "Final files", amount: 4 },
    ]);
    expect(brief.budget).not.toBe(50);
  });

  it("falls back to the milestone's description when it has no requirements", async () => {
    chainSays({ milestones: [{ amount: 2_000_000n, requirements: "", description: "Draft" }] });
    await adoptDelegatedJobs();
    expect(JSON.parse(insertTask.mock.calls[0][0].briefJson).milestones[0].description).toBe("Draft");
  });

  it("skips the job rather than adopting one it cannot price", async () => {
    chainSays();
    generateBrief.mockRejectedValue(new Error("model down"));
    expect(await adoptDelegatedJobs()).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });
});

/**
 * Taking a job back has to work as immediately as handing it over. The task row
 * outlived the revocation, so Browse Jobs kept showing "AUTOPILOT MANAGED" on a
 * job the agent was already locked out of.
 */
describe("giving a job back", () => {
  it("drops the task row when the client revokes", async () => {
    getLogs.mockResolvedValue([]);
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).toHaveBeenCalledWith("delegated-7");
  });

  it("keeps a job commissioned through the API, which is not ours to forget", async () => {
    getLogs.mockResolvedValue([]);
    listTasks.mockReturnValue([{ id: "task-abc", escrowId: "9" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("keeps a delegated job we still manage", async () => {
    chainSays();
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  /*
   * Revocation is not the only way a job stops being work. jobManager stays set
   * on a cancelled escrow forever, so the sweep above never noticed — and the
   * agent went on advertising `delegated-4`, status "posted", for a job that had
   * been cancelled and that the chain refused every call on.
   */
  it("releases a job the client has cancelled, even though we still manage it", async () => {
    chainSays({ esc: { status: 6 } });
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).toHaveBeenCalledWith("delegated-7");
  });

  it("releases a job that has completed", async () => {
    chainSays({ esc: { status: 2 } });
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).toHaveBeenCalledWith("delegated-7");
  });

  /* A failed read is not evidence that a job ended. */
  it("keeps the task when the escrow cannot be read", async () => {
    chainSays();
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "jobManager") return AGENT;
      throw new Error("rpc down");
    });
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).not.toHaveBeenCalled();
  });
});

describe("when there is no agent wallet", () => {
  it("does nothing rather than failing the poll", async () => {
    vi.resetModules();
    vi.doMock("../src/circle/circleSigner.js", () => ({
      createCircleSigner: () => { throw new Error("no Circle credentials"); },
    }));
    const { adoptDelegatedJobs: fresh } = await import("../src/agent/adoptDelegated.js");
    await expect(fresh()).resolves.toBe(0);
    vi.doUnmock("../src/circle/circleSigner.js");
  });
});

/**
 * NOT RESCANNING THE WHOLE CHAIN EVERY FIFTEEN SECONDS.
 *
 * This walked from the contract's deploy block on every sweep — about 780,000
 * blocks in 9,000-block windows, so eighty-seven getLogs calls, four times a
 * minute. The RPC began answering "rate limit exceeded" and every one of them
 * failed, which meant a client handing a job to Autopilot was quietly never
 * picked up. A sweep that found nothing looked exactly like a sweep with
 * nothing to find.
 */
describe("how much chain it reads", () => {
  beforeEach(() => {
    getPollerInt.mockReturnValue(null);
    getPollerText.mockReturnValue(null);
  });

  it("reads from the deploy block the first time", async () => {
    chainSays();
    await adoptDelegatedJobs();

    const firstFrom = getLogs.mock.calls[0]?.[0]?.fromBlock;
    expect(firstFrom).toBe(0n); // the test config's deploy block
  });

  it("remembers where it got to", async () => {
    chainSays();
    await adoptDelegatedJobs();

    expect(setPollerInt).toHaveBeenCalledWith(
      expect.stringContaining("scan_cursor:jobmanager:"),
      100, // the mocked head
    );
  });

  it("resumes from there rather than starting over", async () => {
    getPollerInt.mockReturnValue(90_000);
    chainSays();
    getBlockNumber.mockResolvedValue(90_100n);

    await adoptDelegatedJobs();

    // Rewound a little, because a read at the tip can miss a reorg's blocks —
    // re-reading a few thousand costs one request, missing an appointment
    // costs somebody their job.
    expect(getLogs.mock.calls[0][0].fromBlock).toBe(85_000n);

    /* A caught-up daemon reads the last few windows and stops, rather than
       walking the chain again. The cap on windows per sweep means "from
       scratch" is also bounded now, so this asserts the cursor was used at all
       — the fromBlock above is the real proof. */
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(25);
  });

  it("keeps the ground a rate-limited sweep gained", async () => {
    /*
     * Saving the cursor only at the end was a deadlock: the first sweep has
     * 780,000 blocks to read, the RPC refuses somewhere in the middle, the
     * sweep throws, nothing is remembered — and the next one starts from the
     * deploy block and fails in the same place, forever. Which is exactly what
     * the daemon was doing.
     */
    getPollerInt.mockReturnValue(null);
    getBlockNumber.mockResolvedValue(1_000n);
    let calls = 0;
    getLogs.mockImplementation(async () => {
      if (++calls > 3) throw new Error("rate limit exceeded");
      return [];
    });

    await adoptDelegatedJobs();

    /* It moved the mark despite failing, so the next sweep resumes rather than
       repeating. Three windows from 0 with a 50-block limit: 0-50, 51-101,
       102-152. */
    expect(setPollerInt).toHaveBeenCalledWith(
      expect.stringContaining("scan_cursor:jobmanager:"),
      152,
    );
  });

  it("keeps appointments seen in earlier sweeps", async () => {
    // The window they appeared in is long behind the cursor; forgetting them
    // would un-adopt a job the agent is actively running.
    getPollerInt.mockReturnValue(90_000);
    getPollerText.mockReturnValue(JSON.stringify(["4"]));
    getBlockNumber.mockResolvedValue(90_100n);
    getLogs.mockResolvedValue([]);
    readContract.mockResolvedValue(AGENT);

    await adoptDelegatedJobs();

    expect(setPollerText).toHaveBeenCalledWith(
      expect.stringContaining("scan_seen:jobmanager:"),
      expect.stringContaining("4"),
    );
  });
});

describe("a sweep that gets refused immediately", () => {
  it("holds its ground rather than losing it", async () => {
    /*
     * The sweep starts a little behind the mark to re-read what a reorg might
     * have changed. When the first window is refused, the cursor is still at
     * that rewound start — and saving it moved the mark BACKWARDS. Every
     * rate-limited sweep lost five thousand blocks, so a daemon under pressure
     * crawled away from the head rather than toward it.
     */
    getPollerInt.mockReturnValue(90_000);
    getBlockNumber.mockResolvedValue(90_100n);
    getLogs.mockRejectedValue(new Error("rate limit exceeded"));

    await adoptDelegatedJobs();

    const moved = setPollerInt.mock.calls.filter((c) =>
      String(c[0]).startsWith("scan_cursor:jobmanager:"),
    );
    expect(moved).toHaveLength(0);
  });
})

describe("a sweep that could not read the whole chain", () => {
  /*
   * The cleanup hands back anything delegated that the scan did not find. A
   * truncated scan cannot tell "the client revoked this" from "I have not read
   * that far yet" — and treating one as the other deleted the task for a job
   * the chain still said the agent managed. The badge vanished off the board
   * and the agent stopped working a live commission.
   *
   * The regression arrived with making the scan survive rate limits. Before
   * that, a refused scan threw and aborted the sweep, which was accidentally
   * safe. Surviving is right; acting on a partial answer is not.
   */
  it("does not hand back jobs it simply has not read yet", async () => {
    listTasks.mockReturnValue([
      { id: "delegated-8", escrowId: "8", status: "posted", briefJson: "{}" },
    ]);
    getPollerInt.mockReturnValue(null);
    getBlockNumber.mockResolvedValue(10_000n);
    // Refused part way, so the scan never reaches escrow 8's appointment.
    let calls = 0;
    getLogs.mockImplementation(async () => {
      if (++calls > 2) throw new Error("rate limit exceeded");
      return [];
    });

    await adoptDelegatedJobs();

    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("still hands back a genuine revocation once it has seen everything", async () => {
    listTasks.mockReturnValue([
      { id: "delegated-8", escrowId: "8", status: "posted", briefJson: "{}" },
    ]);
    getPollerInt.mockReturnValue(null);
    getBlockNumber.mockResolvedValue(100n);
    getLogs.mockResolvedValue([]); // a complete scan that found no appointment

    await adoptDelegatedJobs();

    expect(deleteTask).toHaveBeenCalledWith("delegated-8");
  });
});
