import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The two endings a client can pick after an arbiter has ruled.
 *
 * What matters here is not the happy render — it is that this panel appears
 * exactly when there is a real choice to make, and never otherwise. Shown too
 * eagerly it offers to refund money on a job nobody disputed; shown too late,
 * a client's remaining budget sits unreachable until the deadline, which is the
 * bug it exists to fix.
 */

const withdrawJobFunds = vi.fn().mockResolvedValue("0xhash");
const reopenJob = vi.fn().mockResolvedValue("0xhash");

vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xC11E27", isConnected: true } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/web3/contract-service", () => ({
  contractService: { withdrawJobFunds, reopenJob },
}));

const { PostDisputeChoice } = await import("@/components/atelier/post-dispute-choice");

type M = {
  description: string;
  amount: string;
  status: string;
  resolvedAt?: number;
};

const usdc = (n: number) => String(Math.round(n * 1e6));

/** Milestone 0 went to an arbiter; milestone 1 was never started. */
const AFTER_RULING: M[] = [
  { description: "Concepts", amount: usdc(1), status: "resolved", resolvedAt: 1_700_000_000 },
  { description: "Final files", amount: usdc(4), status: "pending" },
];

function panel(props: Partial<Parameters<typeof PostDisputeChoice>[0]> = {}) {
  return render(
    <PostDisputeChoice
      escrowId={4}
      isClient
      status="active"
      milestones={AFTER_RULING as never}
      {...props}
    />,
  );
}

beforeEach(() => {
  withdrawJobFunds.mockClear();
  reopenJob.mockClear();
});

describe("when the choice is offered", () => {
  it("appears once an arbiter has ruled and something is unstarted", () => {
    panel();
    expect(screen.getByTestId("post-dispute-choice")).toBeInTheDocument();
  });

  it("names the amount actually still held, not the original budget", () => {
    panel();
    // 4 USDC unstarted — the 1 that went to arbitration is settled and gone.
    expect(screen.getByRole("button", { name: /return \$4\.00 to me/i })).toBeInTheDocument();
  });

  it("stays hidden on a job that was never disputed", () => {
    panel({
      milestones: [
        { description: "Concepts", amount: usdc(1), status: "approved" },
        { description: "Final files", amount: usdc(4), status: "pending" },
      ] as never,
    });
    expect(screen.queryByTestId("post-dispute-choice")).not.toBeInTheDocument();
  });

  /* Everything has been delivered — there is nothing to reclaim or hand on. */
  it("stays hidden when nothing is left unstarted", () => {
    panel({
      milestones: [
        { description: "Concepts", amount: usdc(1), status: "resolved", resolvedAt: 1 },
        { description: "Final files", amount: usdc(4), status: "submitted" },
      ] as never,
    });
    expect(screen.queryByTestId("post-dispute-choice")).not.toBeInTheDocument();
  });

  it("is never shown to the freelancer", () => {
    panel({ isClient: false });
    expect(screen.queryByTestId("post-dispute-choice")).not.toBeInTheDocument();
  });

  it("is not shown once the job has finished", () => {
    panel({ status: "completed" });
    expect(screen.queryByTestId("post-dispute-choice")).not.toBeInTheDocument();
  });
});

describe("what each button does", () => {
  it("returns every unstarted milestone, in the milestone's own units", async () => {
    panel();
    await userEvent.click(screen.getByRole("button", { name: /return \$4\.00 to me/i }));

    expect(withdrawJobFunds).toHaveBeenCalledOnce();
    const [args] = withdrawJobFunds.mock.calls[0];
    expect(args).toMatchObject({ escrow_id: 4, milestone_index: 1 });
    // The service scales a human figure; passing raw 6-decimal units here would
    // have tried to withdraw four million dollars.
    expect(args.withdraw_amount).toBe("4");
  });

  it("hands the job on without touching the money", async () => {
    panel();
    await userEvent.click(screen.getByRole("button", { name: /let someone else finish it/i }));

    expect(reopenJob).toHaveBeenCalledWith(4, expect.anything());
    expect(withdrawJobFunds).not.toHaveBeenCalled();
  });

  it("says the record survives, since that is what makes reopening fair", () => {
    panel();
    expect(screen.getByText(/keeps the whole record/i)).toBeInTheDocument();
  });
});
