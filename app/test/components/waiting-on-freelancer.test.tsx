import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * HIRED, AND STILL NOTHING.
 *
 * A client whose freelancer never starts is not stranded — before work begins
 * the money is still theirs and comes back in one transaction. But that was
 * true and invisible: you had to already know cancelJob would work on an
 * assigned job to find your way out of one.
 *
 * The two things this has to get right are both about restraint. It must not
 * appear the morning after a hire, because someone hired two hours ago is not
 * ghosting anyone and a product that offers to undo the hire immediately reads
 * as expecting the freelancer to fail. And when it does appear, the first thing
 * it offers is a message, not an exit.
 */

const cancelJob = vi.fn().mockResolvedValue("0xhash");
const toast = vi.fn();

vi.mock("wagmi", () => ({ useWriteContract: () => ({ writeContractAsync: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: class { cancelJob = cancelJob; },
}));

const { WaitingOnFreelancer } = await import("@/components/atelier/waiting-on-freelancer");

const WORKER = "0xfC3642978a1a46ff751ee259906E07ddD7d43Bd1";
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => Date.now() - n * DAY;

function panel(props: Record<string, unknown> = {}) {
  return render(
    <WaitingOnFreelancer
      escrowId={5}
      isClient
      status="pending"
      beneficiary={WORKER}
      hiredAt={daysAgo(3)}
      onMessage={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("when it speaks up", () => {
  it("appears once the silence has gone on for days", () => {
    panel();
    expect(screen.getByTestId("waiting-on-freelancer")).toBeInTheDocument();
    expect(screen.getByText(/3 days since you hired them/i)).toBeInTheDocument();
  });

  /* Somebody hired this morning is not ghosting anyone. */
  it("says nothing on the day of the hire", () => {
    panel({ hiredAt: Date.now() - 2 * 60 * 60 * 1000 });
    expect(screen.queryByTestId("waiting-on-freelancer")).not.toBeInTheDocument();
  });

  it("counts one day in the singular", () => {
    panel({ hiredAt: daysAgo(1) });
    expect(screen.getByText(/1 day since/i)).toBeInTheDocument();
  });

  it("says nothing once they have started", () => {
    panel({ status: "active" });
    expect(screen.queryByTestId("waiting-on-freelancer")).not.toBeInTheDocument();
  });

  it("says nothing on a job with nobody on it", () => {
    panel({ beneficiary: ZERO });
    expect(screen.queryByTestId("waiting-on-freelancer")).not.toBeInTheDocument();
  });

  it("is never shown to the freelancer", () => {
    panel({ isClient: false });
    expect(screen.queryByTestId("waiting-on-freelancer")).not.toBeInTheDocument();
  });
});

describe("what it tells the client", () => {
  /* The fear this answers is "is my money gone". */
  it("says the money is still theirs and nothing has been released", () => {
    panel();
    expect(screen.getByText(/your money is still yours/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing has been released/i)).toBeInTheDocument();
  });

  it("says taking it back is free, because nobody applied", () => {
    panel();
    expect(screen.getByText(/costs you nothing/i)).toBeInTheDocument();
  });

  /* Most silence is a busy week, not a disappearance. */
  it("offers a message before it offers an exit", () => {
    panel();
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons[0]).toMatch(/ask them/i);
  });
});

describe("taking the money back", () => {
  it("cancels the job", async () => {
    panel();
    await userEvent.click(screen.getByTestId("waiting-reclaim"));
    await waitFor(() => expect(cancelJob).toHaveBeenCalled());
    expect(cancelJob.mock.calls[0][0]).toMatchObject({ escrow_id: 5 });
  });

  it("says a failure was a failure rather than pretending it worked", async () => {
    cancelJob.mockRejectedValue(new Error("user rejected"));
    panel();
    await userEvent.click(screen.getByTestId("waiting-reclaim"));
    await waitFor(() =>
      expect(toast.mock.calls.some(([t]) => /could not cancel/i.test(t.title))).toBe(true),
    );
  });
});
