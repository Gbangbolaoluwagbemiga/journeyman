import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Scoping the decision log to one job.
 *
 * The daemon's two tables are keyed differently — tasks carry the escrow id,
 * decisions carry the task id — so every per-job log is a join. The bug this
 * guards against is subtle and would look plausible on screen: a caller who
 * fetched every decision, latched escalation across the whole list, and THEN
 * filtered by job would show a job as escalated because a different client's
 * job was. The join has to happen before the latch.
 */

vi.mock("@/lib/atelier/agent-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/atelier/agent-api")>();
  return actual;
});

const TASK_A = "task-a";
const TASK_B = "task-b";

function decisionRow(id: string, task: string, type: string, at: number) {
  return {
    id,
    task_id: task,
    type,
    reasoning: `reason ${id}`,
    target: null,
    score: null,
    timestamp: at,
  };
}

const TASKS = [
  { id: TASK_A, escrowId: "7", instruction: "logo", clientType: "human", status: "active", briefJson: null, createdAt: 1 },
  { id: TASK_B, escrowId: "9", instruction: "article", clientType: "agent", status: "active", briefJson: null, createdAt: 1 },
];

/* Job B escalates. Job A never does. Interleaved in time so a global latch
   would bleed B's escalation into A's later decisions. */
const DECISIONS = [
  decisionRow("a1", TASK_A, "brief_generated", 100),
  decisionRow("b1", TASK_B, "brief_generated", 110),
  decisionRow("b2", TASK_B, "escalated_to_human", 120),
  decisionRow("a2", TASK_A, "applicant_accepted", 130),
  decisionRow("a3", TASK_A, "payment_released", 140),
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("VITE_AGENT_API_URL", "https://daemon.test");
  fetchMock = vi.fn(async (url: string) => {
    const body = url.includes("/api/tasks") ? TASKS : DECISIONS;
    return { ok: true, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("fetchDecisionsForEscrow", () => {
  it("returns only the decisions belonging to that escrow's task", async () => {
    const { fetchDecisionsForEscrow } = await import("@/lib/atelier/agent-api");
    const log = await fetchDecisionsForEscrow(7);

    expect(log.map((d) => d.id)).toEqual(["a1", "a2", "a3"]);
  });

  /**
   * The one that matters. Job A must not inherit job B's escalation, even
   * though B escalated earlier in wall-clock time.
   */
  it("does not leak another job's escalation into this one", async () => {
    const { fetchDecisionsForEscrow } = await import("@/lib/atelier/agent-api");
    const log = await fetchDecisionsForEscrow(7);

    expect(log.every((d) => d.by === "agent")).toBe(true);
  });

  it("still latches escalation within the job that actually escalated", async () => {
    const { fetchDecisionsForEscrow } = await import("@/lib/atelier/agent-api");
    const log = await fetchDecisionsForEscrow(9);

    expect(log.map((d) => d.by)).toEqual(["agent", "human"]);
  });

  it("returns an empty log for an escrow the daemon never saw", async () => {
    const { fetchDecisionsForEscrow } = await import("@/lib/atelier/agent-api");
    expect(await fetchDecisionsForEscrow(4242)).toEqual([]);
  });

  it("matches escrow ids across number and string forms", async () => {
    const { fetchDecisionsForEscrow } = await import("@/lib/atelier/agent-api");
    const byNumber = await fetchDecisionsForEscrow(7);
    const byString = await fetchDecisionsForEscrow("7");
    expect(byString.map((d) => d.id)).toEqual(byNumber.map((d) => d.id));
  });

  it("orders the log oldest first, because it is read downward", async () => {
    const { fetchDecisionsForEscrow } = await import("@/lib/atelier/agent-api");
    const log = await fetchDecisionsForEscrow(7);
    const times = log.map((d) => d.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

/*
 * Not tested here: the AUTOPILOT_CONFIGURED === false path.
 *
 * `VITE_AGENT_API_URL` is read at module scope, and Vite replaces
 * `import.meta.env.VITE_*` statically at transform time — so vi.stubEnv plus
 * resetModules cannot move it, and a test that appears to check it would only
 * be re-asserting the value the test runner was configured with.
 *
 * The behaviour it would cover (every fetch throws AutopilotUnavailable rather
 * than requesting a relative URL against the app's own origin) is enforced by
 * the single `if (!AUTOPILOT_CONFIGURED) throw` at the top of `get`, which every
 * request in this module goes through.
 */
