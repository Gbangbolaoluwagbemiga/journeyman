import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * AutopilotControl is the client's answer to "who is running this job, and how
 * do I change it". The behaviour worth pinning is not the happy render — it is
 * the three ways this component can say something false:
 *
 *   1. showing a freelancer their client's mode (leaks the marketplace split)
 *   2. saying "you are running this job" before it knows (every Autopilot job
 *      would flash the wrong answer on mount)
 *   3. hiding the way back out (makes delegation feel one-way, so nobody tries)
 */

const delegate = vi.fn().mockResolvedValue("0xhash");
const revoke = vi.fn().mockResolvedValue("0xhash");

let hookState = {
  manager: null as string | null,
  loaded: true,
  busy: false,
  error: null as string | null,
  delegate,
  revoke,
  refresh: vi.fn(),
};

vi.mock("@/hooks/use-job-manager", () => ({
  useJobManager: () => hookState,
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

const fetchLimits = vi.fn().mockResolvedValue({ applicationWindowMinutes: 3 });
/* The per-job window, which the card now prefers over the global default: a
   client who asked for a day must not be shown the deployment's three minutes. */
const fetchJobCriteria = vi.fn().mockResolvedValue({
  criteria: [],
  source: "none",
  applicationWindowMinutes: 3,
});
const fetchHandoverPreview = vi.fn().mockResolvedValue({
  escrowId: "1",
  title: "A job",
  criteria: [],
  applicationWindowMinutes: 3,
  defaultWindowMinutes: 3,
  minWindowMinutes: 1,
  maxWindowMinutes: 10080,
  approved: false,
});
const saveHandoverPrefs = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchLimits,
  fetchJobCriteria,
  fetchHandoverPreview,
  saveHandoverPrefs,
  handoverMessage: (a: string, id: number, w: number) =>
    `Atelier: hand job #${id} to Autopilot\nReview window: ${w} minute(s)\nClient: ${a.toLowerCase()}`,
}));

/* The card signs only when the client changes the window from the default. */
const signMessageAsync = vi.fn().mockResolvedValue("0xsig");
vi.mock("wagmi", () => ({ useSignMessage: () => ({ signMessageAsync }) }));

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xc11e00000000000000000000000000000000000a" } }),
}));

const { AutopilotControl } = await import(
  "@/components/atelier/autopilot-control"
);

const MANAGER = "0xa9e2700000000000000000000000000000000001";

beforeEach(() => {
  hookState = {
    manager: null,
    loaded: true,
    busy: false,
    error: null,
    delegate,
    revoke,
    refresh: vi.fn(),
  };
  delegate.mockClear();
  revoke.mockClear();
  toast.mockClear();

  /* Reset the resolved values too, not just the call lists. A test that sets a
     persistent mockRejectedValue otherwise leaks its outage into every test
     after it, and they fail for a reason that has nothing to do with them. */
  signMessageAsync.mockClear().mockResolvedValue("0xsig");
  saveHandoverPrefs.mockClear().mockResolvedValue(undefined);
  fetchLimits.mockClear().mockResolvedValue({ applicationWindowMinutes: 3 });
  fetchJobCriteria.mockClear().mockResolvedValue({
    criteria: [],
    source: "none",
    applicationWindowMinutes: 3,
  });
  fetchHandoverPreview.mockClear().mockResolvedValue({
    escrowId: "1",
    title: "A job",
    criteria: [],
    applicationWindowMinutes: 3,
    defaultWindowMinutes: 3,
    minWindowMinutes: 1,
    maxWindowMinutes: 10080,
    approved: false,
  });
});

describe("who may see it", () => {
  /**
   * The rule this protects: a freelancer must not be able to tell whether their
   * client is a person or an agent. The call site in escrow-card already gates
   * on isClient; this asserts the component does not rely on that being
   * remembered at every future call site.
   */
  it("renders nothing for a non-client, even on an Autopilot job", () => {
    hookState.manager = MANAGER;
    const { container } = render(
      <AutopilotControl escrowId={1} isClient={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders for the job's own client", () => {
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(screen.getByText(/you are running this job/i)).toBeInTheDocument();
  });
});

describe("what it says before it knows", () => {
  /**
   * `manager === null` is a real answer meaning "the client runs it", not a
   * loading state. Rendering it as such would make every Autopilot job flash
   * "you are running this job" on mount — the single most misleading thing this
   * component could say.
   */
  it("does not claim the client is in charge while still loading", () => {
    hookState.loaded = false;
    render(<AutopilotControl escrowId={1} isClient={true} />);

    expect(screen.queryByText(/you are running this job/i)).toBeNull();
    expect(screen.queryByText(/autopilot is running this job/i)).toBeNull();
    expect(screen.getByText(/checking who manages/i)).toBeInTheDocument();
  });
});

describe("the two states", () => {
  it("offers a manual job the way in", () => {
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(screen.getByText(/you are running this job/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /hand to autopilot/i }),
    ).toBeEnabled();
  });

  it("offers an Autopilot job the way out, and names the agent", () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient={true} />);

    expect(
      screen.getByText(/autopilot is running this job/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /take back control/i }),
    ).toBeEnabled();
    // The client can see which address actually holds the delegation.
    expect(screen.getByText(/0xa9e2/i)).toBeInTheDocument();
  });

  /**
   * Revoke is never gated behind a confirmation, a settings page, or the agent
   * being reachable. If taking control back is awkward, handing it over stops
   * being a reasonable thing to try.
   */
  it("keeps the exit available while the agent is mid-action", () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(
      screen.getByRole("button", { name: /take back control/i }),
    ).toBeInTheDocument();
  });

  it("disables the button while a transaction is in flight", () => {
    hookState.busy = true;
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(
      screen.getByRole("button", { name: /hand to autopilot/i }),
    ).toBeDisabled();
  });
});

/**
 * Handing over is one transaction that names an address. Everything the agent
 * then does, it decides from what is already on-chain — so the client has to
 * see that before signing, not discover it when work is rejected.
 */
describe("what the client is shown before handing over", () => {
  const WITH_CRITERIA =
    "A logo for a coffee roastery.\n\nAcceptance criteria:\n• Delivered in SVG and PNG\n• Transparent background";

  it("does not delegate on the first click", async () => {
    render(<AutopilotControl escrowId={1} isClient={true} projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(delegate).not.toHaveBeenCalled();
  });

  it("shows the criteria the agent will judge against", async () => {
    render(<AutopilotControl escrowId={1} isClient={true} projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(screen.getByText(/Delivered in SVG and PNG/)).toBeInTheDocument();
    expect(screen.getByText(/Transparent background/)).toBeInTheDocument();
  });

  it("shows the stages it will pay out in", async () => {
    render(
      <AutopilotControl
        escrowId={1}
        isClient={true}
        projectDescription={WITH_CRITERIA}
        milestones={[{ description: "Initial concepts", amount: "1000000" }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText("Initial concepts")).toBeInTheDocument();
  });

  /* The case this dialog exists for. A hand-created job stores only free text,
     so the agent derives criteria the client never wrote. */
  it("warns when the job carries no criteria for the agent to read", async () => {
    render(
      <AutopilotControl escrowId={1} isClient={true} projectDescription="Just make me a logo." />,
    );
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(screen.getByText(/no acceptance criteria written into it/i)).toBeInTheDocument();
  });

  it("delegates only after the client confirms", async () => {
    render(<AutopilotControl escrowId={1} isClient={true} projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));
    expect(delegate).toHaveBeenCalledOnce();
  });

  /*
   * THE CRITERIA ARE WRITTEN BEFORE THE SIGNATURE, NOT AFTER IT.
   *
   * The agent always generated them — adoptDelegated ran the brief generator
   * the moment the delegation landed on-chain. It ran on the far side of the
   * point of no return, so this dialog could only warn that the client "may be
   * judged against wording you have not seen". Now the same generator runs
   * first and the client reads the actual standard.
   */
  it("shows the criteria Autopilot drafted, over anything stored in the text", async () => {
    fetchHandoverPreview.mockResolvedValue({
      escrowId: "1",
      title: "A job",
      criteria: ["Ships as a Figma file", "Two rounds of revision included"],
      applicationWindowMinutes: 3,
      defaultWindowMinutes: 3,
      minWindowMinutes: 1,
      maxWindowMinutes: 10080,
      approved: false,
    });

    render(<AutopilotControl escrowId={1} isClient projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByText(/Ships as a Figma file/)).toBeInTheDocument();
    expect(screen.getByText(/Freelancers see these on the job/i)).toBeInTheDocument();
  });

  it("admits it when Autopilot cannot be reached to draft them", async () => {
    // Better than an empty list, which reads as "this job has no standard".
    fetchHandoverPreview.mockRejectedValue(new Error("daemon offline"));

    render(<AutopilotControl escrowId={1} isClient projectDescription="Just make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByText(/could not be reached to draft criteria/i)).toBeInTheDocument();
  });
});

/**
 * HOW LONG APPLICATIONS STAY OPEN.
 *
 * Three minutes was hard-coded — a demo number. Nobody finds, reads and applies
 * to a real commission in three minutes, so in practice every job went to
 * whoever happened to be watching the board. The daemon has honoured a per-job
 * window all along; nothing ever set it.
 */
describe("choosing the review window", () => {
  it("offers the choice at the moment the client hands the job over", async () => {
    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByRole("button", { name: /24 hours/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3 minutes/i })).toBeInTheDocument();
  });

  it("costs no signature when the client keeps the default", async () => {
    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await screen.findByRole("button", { name: /24 hours/i });
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(delegate).toHaveBeenCalled());
    // The client already signed a transaction; a second popup that changes
    // nothing is exactly the noise they complained about.
    expect(signMessageAsync).not.toHaveBeenCalled();
    expect(saveHandoverPrefs).not.toHaveBeenCalled();
  });

  it("saves the window even when the criteria draft failed", async () => {
    /*
     * The save was gated on the preview — a language-model call that drafts
     * acceptance criteria. When that failed, which it does whenever the model
     * is busy, the client's chosen window was silently discarded and the job
     * ran on the three-minute default. Nothing told them; the toast
     * congratulated them on the four hours they had picked.
     */
    fetchHandoverPreview.mockRejectedValue(new Error("model busy"));

    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await screen.findByText(/could not be reached to draft criteria/i);
    await userEvent.click(await screen.findByRole("button", { name: /^4 hours/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(saveHandoverPrefs).toHaveBeenCalled());
    expect(saveHandoverPrefs.mock.calls[0][0]).toMatchObject({
      applicationWindowMinutes: 240,
    });
  });

  it("says what the window actually is, not what was asked for", async () => {
    // The toast read the picker straight off, so it announced four hours
    // whether or not anything was recorded. A confirmation that confirms your
    // intention rather than the outcome is why nobody noticed.
    saveHandoverPrefs.mockRejectedValue(new Error("offline"));

    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^4 hours/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const said = toast.mock.calls.map((c) => JSON.stringify(c[0])).join(" ");
    expect(said).toMatch(/could not be saved/i);
    expect(said).not.toMatch(/stay open for 4 hours/i);
  });

  it("records a changed window against the job, signed", async () => {
    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(await screen.findByRole("button", { name: /24 hours/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(saveHandoverPrefs).toHaveBeenCalled());
    expect(saveHandoverPrefs.mock.calls[0][0]).toMatchObject({
      escrowId: 1,
      applicationWindowMinutes: 1440,
    });
  });

  it("saves the window only after the hand-over is actually mined", async () => {
    // Otherwise the daemon holds instructions for a job it does not manage —
    // the client rejected the wallet prompt, or the transaction reverted.
    delegate.mockRejectedValueOnce(new Error("user rejected"));

    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(await screen.findByRole("button", { name: /24 hours/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(delegate).toHaveBeenCalled());
    expect(saveHandoverPrefs).not.toHaveBeenCalled();
  });

  it("keeps the job when only the window fails to save", async () => {
    // The delegation is on-chain and already succeeded. Telling the client it
    // failed would be false, and would send them to undo something that worked.
    saveHandoverPrefs.mockRejectedValueOnce(new Error("daemon offline"));

    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(await screen.findByRole("button", { name: /24 hours/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(saveHandoverPrefs).toHaveBeenCalled());
    expect(delegate).toHaveBeenCalledOnce();
  });
});

/**
 * WHEN THE AGENT DECIDES.
 *
 * A client handed a job over and had no way to know whether hiring would happen
 * in a second, in an hour, or only once they went and asked. The panel said
 * what the agent does and never when.
 *
 * It waits on purpose: scoring the first application to arrive would make this
 * a race rather than a comparison, and comparing applicants against each other
 * is the claim the whole feature rests on.
 */
describe("when it will decide", () => {
  it("names the window it leaves applications open for", async () => {
    fetchLimits.mockResolvedValue({ applicationWindowMinutes: 3 });
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/3 minutes/)).toBeInTheDocument();
  });

  it("says why it waits, rather than looking slow", async () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(
      await screen.findByText(/rather than hiring\s+whoever happened to apply first/i),
    ).toBeInTheDocument();
  });

  /* Someone who applied in good time must not be told they were too late. */
  it("says a later applicant is still read", async () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/still picked up on the next pass/i)).toBeInTheDocument();
  });

  /*
   * THIS job's window, not the deployment's.
   *
   * The card read /api/limits, which is the global default, so a client who had
   * asked for a day was still shown "3 minutes" on their own job — the one
   * number on this card that the client themselves chose, reported wrong.
   */
  it("reads the window from the job, not the global default", async () => {
    fetchJobCriteria.mockResolvedValue({
      criteria: [],
      source: "approved",
      applicationWindowMinutes: 1440,
    });
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/a day/i)).toBeInTheDocument();
  });

  it("falls back to the deployment default when the job has no answer", async () => {
    fetchJobCriteria.mockRejectedValue(new Error("no such job"));
    fetchLimits.mockResolvedValue({ applicationWindowMinutes: 60 });
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/an hour/i)).toBeInTheDocument();
  });

  /* An unreachable daemon must not put a made-up number on the screen. */
  it("says nothing about timing when the daemon cannot be reached", async () => {
    fetchJobCriteria.mockRejectedValue(new Error("offline"));
    fetchLimits.mockRejectedValue(new Error("offline"));
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    await waitFor(() => expect(fetchLimits).toHaveBeenCalled());
    expect(screen.queryByText(/minutes/)).not.toBeInTheDocument();
  });
});

/**
 * A JOB THAT ALREADY HAS SOMEBODY ON IT IS PAST HIRING.
 *
 * Autopilot on such a job reviews submissions and releases payment — there is
 * nobody left for it to choose. Asking the client how long to leave
 * applications open asks about a decision already made, and the card went on
 * promising a window that would never open.
 */
describe("handing over a job that is already assigned", () => {
  const HIRED = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";

  it("does not offer a review window", async () => {
    render(<AutopilotControl escrowId={1} isClient assignedTo={HIRED} projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByText(/already has a freelancer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /24 hours/i })).not.toBeInTheDocument();
  });

  it("says what it will do instead of hiring", async () => {
    render(<AutopilotControl escrowId={1} isClient assignedTo={HIRED} projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByText(/review what they submit/i)).toBeInTheDocument();
  });

  it("never asks for a window signature on an assigned job", async () => {
    render(<AutopilotControl escrowId={1} isClient assignedTo={HIRED} projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    await waitFor(() => expect(delegate).toHaveBeenCalled());
    expect(signMessageAsync).not.toHaveBeenCalled();
    expect(saveHandoverPrefs).not.toHaveBeenCalled();
  });

  it("stops promising an application window on the running card", async () => {
    fetchJobCriteria.mockResolvedValue({ criteria: [], source: "brief", applicationWindowMinutes: 1440 });
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient assignedTo={HIRED} />);

    await waitFor(() => expect(fetchJobCriteria).toHaveBeenCalled());
    expect(screen.queryByText(/leaves applications open/i)).not.toBeInTheDocument();
  });

  /* The zero address is "nobody", not somebody. */
  it("treats an unassigned job as open for hiring", async () => {
    render(
      <AutopilotControl
        escrowId={1}
        isClient
        assignedTo="0x0000000000000000000000000000000000000000"
        projectDescription="Make me a logo."
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByRole("button", { name: /24 hours/i })).toBeInTheDocument();
  });
});

/**
 * WHEN THE TITLE AND THE JOB DISAGREE.
 *
 * Escrow 7 was titled "fireball" and described a Discord role problem. Nothing
 * told the generator which to believe, so it chose — and chose differently on
 * different runs, producing a vector illustration commission once and an
 * account recovery job the next time. The same cover letter scored 25 against
 * one and 70 against the other, and the 70 hired them.
 *
 * The brief is now always written from the description. The contradiction is
 * raised rather than resolved, because only the client knows which they meant.
 */
describe("a job whose title contradicts its description", () => {
  it("warns the client before they sign it over", async () => {
    fetchHandoverPreview.mockResolvedValue({
      escrowId: "7",
      title: "fireball",
      criteria: ["Discord \"sus\" role is removed"],
      titleConflict:
        'The title "fireball" implies an illustration, while the description asks for a Discord role to be removed.',
      applicationWindowMinutes: 3,
      defaultWindowMinutes: 3,
      minWindowMinutes: 1,
      maxWindowMinutes: 10080,
      approved: false,
    });

    render(<AutopilotControl escrowId={7} isClient projectDescription="…" />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    expect(await screen.findByText(/ask for different things/i)).toBeInTheDocument();
    expect(screen.getByText(/implies an illustration/i)).toBeInTheDocument();
    // Says which one won, and what to do if that is the wrong one.
    expect(screen.getByText(/written from your description, not/i)).toBeInTheDocument();
  });

  it("stays quiet when the title and description agree", async () => {
    render(<AutopilotControl escrowId={1} isClient projectDescription="Make me a logo." />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));

    await screen.findByRole("button", { name: /24 hours/i });
    expect(screen.queryByText(/ask for different things/i)).not.toBeInTheDocument();
  });
});

/**
 * THE CARD AND THE TOAST HAVE TO AGREE.
 *
 * The window was read once on mount, so after a hand-over the panel kept
 * quoting whatever it was when the page loaded. Somebody picked twenty-four
 * hours, the toast said "a day" because it reports what was saved, and the
 * panel underneath went on promising the four hours from the delegation
 * before. Two true-looking numbers about the same job, and the wrong one is
 * the one that stays on screen.
 */
describe("the window shown after handing over", () => {
  it("matches what was just saved, not what was there before", async () => {
    // The job currently runs a four-hour window.
    fetchJobCriteria.mockResolvedValue({
      criteria: [], source: "brief", applicationWindowMinutes: 240,
    });

    const { rerender } = render(
      <AutopilotControl escrowId={8} isClient projectDescription="Make me a dashboard." />,
    );

    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(await screen.findByRole("button", { name: /24 hours/i }));

    // From here the daemon would answer with the new window.
    fetchJobCriteria.mockResolvedValue({
      criteria: [], source: "approved", applicationWindowMinutes: 1440,
    });

    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));
    await waitFor(() => expect(saveHandoverPrefs).toHaveBeenCalled());

    hookState.manager = MANAGER;
    rerender(<AutopilotControl escrowId={8} isClient projectDescription="Make me a dashboard." />);

    expect(await screen.findByText(/a day/i)).toBeInTheDocument();
    expect(screen.queryByText(/4 hours/i)).not.toBeInTheDocument();
  });

  it("asks the daemon again rather than trusting the picker", async () => {
    fetchJobCriteria.mockResolvedValue({
      criteria: [], source: "brief", applicationWindowMinutes: 240,
    });

    render(<AutopilotControl escrowId={8} isClient projectDescription="Make me a dashboard." />);
    await waitFor(() => expect(fetchJobCriteria).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(await screen.findByRole("button", { name: /24 hours/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));

    // The optimistic value is shown at once; the daemon still gets asked, so a
    // save that only half-worked cannot leave a wrong number on screen.
    await waitFor(() => expect(fetchJobCriteria).toHaveBeenCalledTimes(2));
  });
});
