import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * SAYING NO, AND WHAT THE CLIENT DOES ABOUT IT.
 *
 * Direct assignment names a freelancer who never agreed. Their only exits were
 * to ignore the job — leaving the client waiting on someone who was never
 * coming, and their budget locked until the deadline — or to start work they
 * did not want.
 *
 * The half that is easy to get wrong is the second one: a decline that decides
 * for the client is barely better than no decline. Only they know whether the
 * reason is something they can fix.
 */

const declineAssignment = vi.fn().mockResolvedValue("0xhash");
const acceptFreelancer = vi.fn().mockResolvedValue("0xhash");
const reopenJob = vi.fn().mockResolvedValue("0xhash");
const cancelJob = vi.fn().mockResolvedValue("0xhash");
const sendMessage = vi.fn().mockResolvedValue({ id: "m1" });
const toast = vi.fn();

vi.mock("wagmi", () => ({ useWriteContract: () => ({ writeContractAsync: vi.fn() }) }));
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xWORKER", isConnected: true } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/api", () => ({ sendMessage, isApiConfigured: () => true }));
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: class {
    declineAssignment = declineAssignment;
    acceptFreelancer = acceptFreelancer;
    reopenJob = reopenJob;
    cancelJob = cancelJob;
  },
}));

const { DeclineAssignment } = await import("@/components/atelier/decline-assignment");
const { DeclinedChoice } = await import("@/components/atelier/declined-choice");

const ZERO = "0x0000000000000000000000000000000000000000";
const WORKER = "0xfC3642978a1a46ff751ee259906E07ddD7d43Bd1";

beforeEach(() => {
  vi.clearAllMocks();
  declineAssignment.mockResolvedValue("0xhash");
  sendMessage.mockResolvedValue({ id: "m1" });
});

describe("the freelancer says no", () => {
  const open = async () => {
    render(
      <DeclineAssignment escrowId={5} clientAddress="0xC11E27" jobTitle="Coffee Roastery Logo" />,
    );
    await userEvent.click(screen.getByTestId("decline-button"));
    return screen.findByTestId("decline-dialog");
  };

  it("says what happens next, so declining is not a leap in the dark", async () => {
    await open();
    expect(screen.getByText(/client will decide what happens next/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is paid or lost/i)).toBeInTheDocument();
  });

  it("declines on chain", async () => {
    await open();
    await userEvent.click(screen.getByTestId("decline-confirm"));
    await waitFor(() => expect(declineAssignment).toHaveBeenCalled());
    expect(declineAssignment.mock.calls[0][0]).toBe(5);
  });

  /* The reason is the start of a negotiation, so it goes where the client can
     reply to it rather than into an event nobody reads. */
  it("sends the reason to the client as a message", async () => {
    await open();
    await userEvent.type(screen.getByTestId("decline-reason"), "The budget is under my rate.");
    await userEvent.click(screen.getByTestId("decline-confirm"));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const body = sendMessage.mock.calls[0][0];
    expect(body.recipient_address).toBe("0xC11E27");
    expect(body.content).toContain("The budget is under my rate.");
    expect(body.content).toContain("Coffee Roastery Logo");
  });

  /* Requiring an explanation to leave would only produce empty strings. */
  it("lets someone decline without explaining themselves", async () => {
    await open();
    await userEvent.click(screen.getByTestId("decline-confirm"));
    await waitFor(() => expect(declineAssignment).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * The transaction is what frees both sides; the note is a courtesy on top. An
   * unreachable message store must not leave a freelancer thinking they are
   * still on the hook.
   */
  it("still counts as declined when the note fails to send", async () => {
    sendMessage.mockRejectedValue(new Error("store down"));
    await open();
    await userEvent.type(screen.getByTestId("decline-reason"), "Booked until March.");
    await userEvent.click(screen.getByTestId("decline-confirm"));

    await waitFor(() => expect(declineAssignment).toHaveBeenCalled());
    expect(toast.mock.calls.some(([t]) => /note didn't send/i.test(t.title))).toBe(true);
  });

  it("does not decline when the client's own dialog is dismissed", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /keep the job/i }));
    expect(declineAssignment).not.toHaveBeenCalled();
  });
});

describe("the client's three answers", () => {
  const panel = (props: Record<string, unknown> = {}) =>
    render(
      <DeclinedChoice
        escrowId={5}
        isClient
        status="pending"
        beneficiary={ZERO}
        isOpenJob={false}
        declinedBy={WORKER}
        {...props}
      />,
    );

  it("offers all three, and none of them by default", () => {
    panel();
    expect(screen.getByTestId("declined-reoffer")).toBeInTheDocument();
    expect(screen.getByTestId("declined-open")).toBeInTheDocument();
    expect(screen.getByTestId("declined-refund")).toBeInTheDocument();
  });

  it("says the money has not moved, which is the first thing a client wonders", () => {
    panel();
    expect(screen.getByText(/money hasn't moved/i)).toBeInTheDocument();
  });

  it("points at the messages, where the reason is", () => {
    panel();
    expect(screen.getByText(/check your messages/i)).toBeInTheDocument();
  });

  it("re-offers to the same freelancer", async () => {
    panel();
    await userEvent.click(screen.getByTestId("declined-reoffer"));
    await waitFor(() => expect(acceptFreelancer).toHaveBeenCalled());
    expect(acceptFreelancer.mock.calls[0][0]).toMatchObject({ escrow_id: 5, freelancer: WORKER });
  });

  it("opens it to everyone", async () => {
    panel();
    await userEvent.click(screen.getByTestId("declined-open"));
    await waitFor(() => expect(reopenJob).toHaveBeenCalledWith(5, expect.anything()));
  });

  it("takes the money back", async () => {
    panel();
    await userEvent.click(screen.getByTestId("declined-refund"));
    await waitFor(() => expect(cancelJob).toHaveBeenCalled());
    expect(cancelJob.mock.calls[0][0]).toMatchObject({ escrow_id: 5 });
  });

  /* Nobody declined, so there is nothing to answer. */
  it("stays hidden on a job that still has its freelancer", () => {
    panel({ beneficiary: WORKER });
    expect(screen.queryByTestId("declined-choice")).not.toBeInTheDocument();
  });

  it("stays hidden on an ordinary open job", () => {
    panel({ isOpenJob: true });
    expect(screen.queryByTestId("declined-choice")).not.toBeInTheDocument();
  });

  it("is never shown to the freelancer", () => {
    panel({ isClient: false });
    expect(screen.queryByTestId("declined-choice")).not.toBeInTheDocument();
  });

  /* Without knowing who handed it back, only two of the three make sense. */
  it("drops the re-offer when we do not know who declined", () => {
    panel({ declinedBy: undefined });
    expect(screen.queryByTestId("declined-reoffer")).not.toBeInTheDocument();
    expect(screen.getByTestId("declined-open")).toBeInTheDocument();
  });
});
