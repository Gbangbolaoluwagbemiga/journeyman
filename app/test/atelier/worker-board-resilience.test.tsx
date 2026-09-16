import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * ONE BAD READ MUST NOT EMPTY THE BOARD.
 *
 * The board loaded three things at once — the open jobs, your work, and your
 * balance — inside a single `Promise.all` with one catch around it. That makes
 * the page exactly as reliable as its least reliable read: a blink from the
 * open-jobs list threw away a perfectly good answer about the work on your
 * bench, and the board rendered "Nothing on your bench right now".
 *
 * That sentence, shown to somebody who has a funded job and money owed, is the
 * worst thing this page can say. It is a confident answer assembled out of a
 * failure — the same shape that made a freelancer's finished job disappear
 * twice before, one layer down each time.
 */

const myWork = vi.fn();
const quests = vi.fn();
const me = vi.fn();

vi.mock("@/lib/atelier/worker", () => ({
  myWork: (id: string) => myWork(id),
  quests: (id: string) => quests(id),
  me: (id: string) => me(id),
  submit: vi.fn(),
  deliveryTarget: vi.fn(),
  uploadAuth: vi.fn(),
  apply: vi.fn(),
  withdraw: vi.fn(),
  minutesUntilClose: () => 0,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/api", () => ({
  isApiConfigured: () => true,
  uploadMilestoneFileWithAuth: vi.fn(),
}));

const { WorkerBoard } = await import("@/components/atelier/worker-board");

const WORKER = {
  id: "w1",
  handle: "cdev",
  address: "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423",
  mode: "managed",
  balance: "1.02",
} as never;

const THE_JOB = {
  escrowId: "7",
  title: "fireball",
  budget: 3,
  status: "All 2 stage(s) approved and paid",
  icon: "✅",
  state: "completed",
};

beforeEach(() => {
  vi.clearAllMocks();
  quests.mockResolvedValue([]);
  me.mockResolvedValue(WORKER);
  myWork.mockResolvedValue([THE_JOB]);
});

describe("the board when one read fails", () => {
  it("still shows your work when the open-jobs list fails", async () => {
    quests.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/fireball/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing on your bench/i)).not.toBeInTheDocument();
  });

  it("still shows your work when the balance read fails", async () => {
    // Exactly the reported case: the RPC was rate-limiting, so the balance came
    // back unreadable — and the whole dashboard reported an empty bench.
    me.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/fireball/)).toBeInTheDocument();
  });

  it("does not claim an empty bench when the work read itself failed", async () => {
    myWork.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    await waitFor(() =>
      expect(screen.queryByText(/Nothing on your bench/i)).not.toBeInTheDocument(),
    );
  });

  it("passes on the balance it did get, even though another read failed", async () => {
    const onWorkerChanged = vi.fn();
    quests.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={onWorkerChanged} />);

    await waitFor(() => expect(onWorkerChanged).toHaveBeenCalledWith(WORKER));
  });
});

/**
 * A JOB HALF-TAKEN-OFF YOU IS NOT A JOB PAID IN FULL.
 *
 * Escrow 7: stage one approved for 3 USDC, stage two disputed and resolved by
 * an arbiter, 2 USDC returned to the client and nothing to the freelancer.
 *
 * Their board read "All 2 stage(s) approved and paid", the dashboard counted a
 * job "paid in full", and opening the details said "Approved and paid in full.
 * Nothing further is needed from you on this one." Three separate sentences,
 * all congratulating somebody on money they did not receive.
 */
describe("a finished job an arbiter ruled on", () => {
  const ARBITRATED = {
    escrowId: "7",
    title: "fireball",
    budget: 3,
    status: "1 of 2 approved · 1 settled by an arbiter — you were paid $3.00 of $5.00",
    icon: "⚖️",
    state: "completed",
    approved: 1,
    arbitrated: 1,
    milestoneCount: 2,
    earnedUsdc: 3,
    canSubmit: false,
  };

  it("does not describe the set as paid in full", async () => {
    myWork.mockResolvedValue([ARBITRATED]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    await screen.findByText(/fireball/);
    expect(screen.queryByText(/paid in full/i)).not.toBeInTheDocument();
    expect(screen.getByText(/went to an arbiter/i)).toBeInTheDocument();
  });

  it("counts the job as finished — it is over, whichever way it went", async () => {
    myWork.mockResolvedValue([ARBITRATED]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    await screen.findByText(/fireball/);
    expect(screen.getByText(/settled by an arbiter/i)).toBeInTheDocument();
  });

  it("still says paid in full when every stage really was approved", async () => {
    myWork.mockResolvedValue([
      { ...ARBITRATED, status: "All 2 stage(s) approved and paid", icon: "✅",
        approved: 2, arbitrated: 0, earnedUsdc: 5 },
    ]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    await screen.findByText(/fireball/);
    expect(screen.getByText(/paid in full/i)).toBeInTheDocument();
  });
});
