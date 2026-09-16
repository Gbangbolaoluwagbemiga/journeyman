import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * THE YIELD SHARE IS A TERM OF THE JOB, NOT A SETTING ON IT.
 *
 * It used to be a switch on the job page, live for the whole life of the
 * escrow. A freelancer reads "this escrow earns while you work and 60% of what
 * it earns is yours" on the board and applies partly because of it — so a
 * client able to flip that off after hiring would be changing the deal after
 * the other side accepted, with no recourse and no notice.
 *
 * It is now asked once while posting, and the contract refuses to let it change
 * once anybody is hired. These two suites are the two halves of that: the
 * question at the start, and the statement of the answer afterwards.
 */

const getYieldStatus = vi.fn();
const setYieldOptIn = vi.fn().mockResolvedValue("0xhash");

/* The chip became a control again for one case — an unanswered question — so it
   reaches for wagmi and the toast hook. */
vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xC11E27", isConnected: true } }),
}));
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: class {
    getYieldStatus = getYieldStatus;
    setYieldOptIn = setYieldOptIn;
  },
}));

const { YieldOptIn } = await import("@/components/atelier/yield-opt-in");
const { YieldChoice } = await import("@/components/create/yield-choice");

const EARNING = {
  available: true,
  optedIn: true,
  choiceMade: true,
  deployed: 0n,
  freelancerShareBP: 6000,
};

beforeEach(() => {
  getYieldStatus.mockReset();
  setYieldOptIn.mockClear();
  getYieldStatus.mockResolvedValue({ ...EARNING });
});

/**
 * Open the chip's tooltip.
 *
 * Radix renders the content twice — once visibly, once in a visually-hidden
 * node for screen readers — so every assertion on tooltip text uses the
 * `All` queries. Matching one would be matching an implementation detail of
 * which copy came first.
 *
 * `userEvent.hover` is not enough: Radix's trigger opens on `pointermove` with
 * a non-touch pointerType, which hover does not dispatch. Focus is sent too, so
 * this covers the keyboard path a screen-reader user takes as well as the mouse
 * one — and if either ever stops working, these go red.
 */
async function openTooltip(chip: HTMLElement) {
  fireEvent.pointerMove(chip, { pointerType: "mouse" });
  fireEvent.focus(chip);
}

describe("choosing, while the job is being posted", () => {
  function choice(props: Record<string, unknown> = {}) {
    const onChange = vi.fn();
    render(<YieldChoice value={false} onChange={onChange} fee={1.25} {...props} />);
    return onChange;
  }

  /**
   * THE FEE IS THE CLIENT'S REASON, AND IT IS REAL NOW.
   *
   * This was framed as a fee choice, which was false — createEscrow charged
   * budget + fee whichever card you picked — and then reframed honestly, which
   * exposed that the feature had no benefit to be honest about. 2.5% refunded
   * out of yield needs a 228-day job at 10% APY.
   *
   * The contract waives the fee outright now, so the framing is both true and
   * worth something.
   */
  it("names the fee on each card, since that is what differs", () => {
    choice();
    expect(screen.getByTestId("yield-choice-fee")).toHaveTextContent("$1.25");
    expect(screen.getByTestId("yield-choice-yield")).toHaveTextContent(/no fee/i);
  });

  it("says how much less the client approves", () => {
    choice();
    expect(screen.getByTestId("yield-choice-yield")).toHaveTextContent(/\$1\.25 less/i);
  });

  /* One extra signature, and it is the one that does the waiving — worth
     saying, since a second wallet prompt otherwise looks like a fault. */
  it("warns about the extra signature and says what it buys", () => {
    choice({ value: true });
    expect(screen.getByTestId("yield-choice-note")).toHaveTextContent(/one extra signature/i);
  });

  it("says out loud that it cannot be changed later", () => {
    choice();
    expect(screen.getByText(/cannot be changed after someone is hired/i)).toBeInTheDocument();
  });

  /* A client should know they are agreeing to the freelancer's share before
     they agree to it, not discover it at settlement. */
  it("states the freelancer's share up front", () => {
    choice();
    expect(screen.getByTestId("yield-choice-yield")).toHaveTextContent(/60%/);
  });

  it("defaults to the client paying, never to opting in silently", () => {
    choice();
    expect(screen.getByTestId("yield-choice-fee")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("yield-choice-yield")).toHaveAttribute("aria-checked", "false");
  });

  it("reports the choice when the client picks the escrow route", async () => {
    const onChange = choice();
    await userEvent.click(screen.getByTestId("yield-choice-yield"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("can be changed back while still on this screen", async () => {
    const onChange = choice({ value: true });
    await userEvent.click(screen.getByTestId("yield-choice-fee"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("mentions the 🌱 tag only once the client has chosen it", () => {
    const { rerender } = render(<YieldChoice value={false} onChange={() => {}} fee={1} />);
    expect(screen.queryByTestId("yield-choice-note")).not.toBeInTheDocument();
    rerender(<YieldChoice value onChange={() => {}} fee={1} />);
    expect(screen.getByTestId("yield-choice-note")).toBeInTheDocument();
  });
});

/**
 * The chip is four words; the detail lives on hover.
 *
 * It used to be a paragraph in a bordered box halfway down the card, restating
 * the mechanism to a client who had already agreed to it when they posted the
 * job — on every card, pushing what actually needs attention further down. A
 * standing fact is not news, and news is what earns vertical space.
 */
describe("stating it, once the job exists", () => {
  const panel = (props: Record<string, unknown> = {}) =>
    render(<YieldOptIn escrowId={5} status="active" {...props} />);

  it("is a short chip, not a paragraph", async () => {
    panel();
    const chip = await screen.findByTestId("yield-status");
    expect(chip).toHaveTextContent(/^Escrow yield$/);
  });

  it("is reachable to a screen reader without hovering anything", async () => {
    panel();
    expect(await screen.findByLabelText(/earns while the job runs/i)).toBeInTheDocument();
  });

  it("keeps the detail out of the way until someone asks for it", async () => {
    panel();
    await screen.findByTestId("yield-status");
    expect(screen.queryByText(/60% of anything beyond that/i)).not.toBeInTheDocument();
  });

  it("explains the split on hover", async () => {
    panel();
    await openTooltip(await screen.findByTestId("yield-status"));
    expect((await screen.findAllByText(/60% of anything beyond that/i)).length).toBeGreaterThan(0);
  });

  it("says on hover that the term was fixed when the job was posted", async () => {
    panel();
    await openTooltip(await screen.findByTestId("yield-status"));
    expect((await screen.findAllByText(/fixed since/i)).length).toBeGreaterThan(0);
  });

  it("shows how much is out earning, in dollars", async () => {
    getYieldStatus.mockResolvedValue({ ...EARNING, deployed: 4_250_000n });
    panel();
    await openTooltip(await screen.findByTestId("yield-status"));
    expect((await screen.findAllByTestId("yield-deployed"))[0]).toHaveTextContent("$4.25");
  });

  /* The whole point of the change upstream: there is nothing here to click. */
  it("offers no control to change it", async () => {
    panel();
    await screen.findByTestId("yield-status");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /* A job that behaves like every other job has nothing to tell anyone. */
  it("renders nothing at all on a job that does not earn", async () => {
    getYieldStatus.mockResolvedValue({ ...EARNING, optedIn: false });
    panel();
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-status")).not.toBeInTheDocument();
  });

  it("renders nothing once the job has settled", async () => {
    panel({ status: "completed" });
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-status")).not.toBeInTheDocument();
  });
});

/**
 * A JOB WHOSE QUESTION WAS NEVER ANSWERED.
 *
 * Two ways to get one: posted before the question existed, or opted in on a
 * yield controller that was later replaced — the controller is not upgradeable,
 * so its book does not carry across.
 *
 * The contract still allows an answer while the freelancer has not started, and
 * the UI should not be stricter than the contract. Offering an unanswered
 * question is not re-opening a settled one: the chain refuses a second answer
 * on its own, so nothing here can take a term back from a freelancer.
 */
describe("a job that never answered the question", () => {
  const UNANSWERED = { ...EARNING, optedIn: false, choiceMade: false };
  const offer = (props: Record<string, unknown> = {}) =>
    render(<YieldOptIn escrowId={5} status="pending" isClient {...props} />);

  it("offers the choice to the client", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer();
    expect(await screen.findByTestId("yield-offer")).toHaveTextContent(/earn while it waits/i);
  });

  it("switches it on, once", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer();
    await userEvent.click(await screen.findByTestId("yield-offer"));
    await waitFor(() => expect(setYieldOptIn).toHaveBeenCalled());
    expect(setYieldOptIn.mock.calls[0].slice(0, 2)).toEqual([5, true]);
  });

  it("warns that the answer is final before taking it", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer();
    await openTooltip(await screen.findByTestId("yield-offer"));
    expect((await screen.findAllByText(/cannot turn it off afterwards/i)).length).toBeGreaterThan(0);
  });

  /**
   * The posting screen waives the fee; this cannot, because the job already
   * paid one. Promising a refund here would be the same worthless offer the
   * whole feature was rebuilt to stop making — 2.5% out of yield needs a
   * 228-day job at 10% APY.
   */
  it("does not pretend switching it on now saves the client anything", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer();
    await openTooltip(await screen.findByTestId("yield-offer"));
    expect(
      (await screen.findAllByText(/costs you nothing and saves you nothing/i)).length,
    ).toBeGreaterThan(0);
  });

  it("says what it does buy: a share for the freelancer", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer();
    await openTooltip(await screen.findByTestId("yield-offer"));
    expect((await screen.findAllByText(/gives the\s+freelancer a share/i)).length).toBeGreaterThan(0);
  });

  /* Answered "no" is answered. Offering again would be re-opening a settled
     question, which is the thing the contract exists to prevent. */
  it("does not offer again to a job that said no", async () => {
    getYieldStatus.mockResolvedValue({ ...EARNING, optedIn: false, choiceMade: true });
    offer();
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-offer")).not.toBeInTheDocument();
  });

  it("does not offer it to the freelancer", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer({ isClient: false });
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-offer")).not.toBeInTheDocument();
  });

  /* No venue means opting in could not lead anywhere, so it would be a button
     that reverts. */
  it("does not offer it when there is nowhere to invest", async () => {
    getYieldStatus.mockResolvedValue({ ...UNANSWERED, available: false });
    offer();
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-offer")).not.toBeInTheDocument();
  });

  it("does not offer it on a settled job", async () => {
    getYieldStatus.mockResolvedValue(UNANSWERED);
    offer({ status: "completed" });
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-offer")).not.toBeInTheDocument();
  });
});
