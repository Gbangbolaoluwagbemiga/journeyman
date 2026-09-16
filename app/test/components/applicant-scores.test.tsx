import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * WHAT THE AGENT SCORED, AND WHO GETS TO SEE IT.
 *
 * The daemon has always written a score and a reason for every applicant. Both
 * were dropped by the mapper between its API and the UI, so the number behind
 * every hire existed on the wire and nowhere a person could read it: a client
 * could not see why one of five people was chosen, and an applicant could not
 * see why they were not. The Telegram bot told them. The web app said nothing.
 *
 * The scoping is the part with a real edge. The client is choosing between
 * people and needs the comparison; an applicant needs to know how they did.
 * Handing an applicant everybody else's score and critique would publish
 * strangers' rejections to each other.
 */

const decisionsState = {
  decisions: [] as unknown[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
};
const managerState = { manager: null as string | null, loaded: true };

vi.mock("@/hooks/use-decisions", () => ({ useDecisions: () => decisionsState }));
vi.mock("@/hooks/use-job-manager", () => ({ useJobManager: () => managerState }));

const { ApplicantScores } = await import("@/components/atelier/applicant-scores");

const AGENT = "0x2eA30Ff0b1E2925CaB8B8B0406C535f5c1E39946";
const ME = "0xfC3642978a1a46ff751ee259906E07ddD7d43Bd1";
const RIVAL = "0xBE9CA06a51f90714E7ab9b6bBC546bBB197a79ba";

function scored(subject: string, score: number, rationale = "Meets the brief.") {
  return { id: `d-${subject}-${score}`, by: "agent", action: "Application scored", rationale, at: Date.now(), score, subject };
}

beforeEach(() => {
  decisionsState.decisions = [];
  decisionsState.loading = false;
  decisionsState.error = null;
  managerState.manager = AGENT;
  managerState.loaded = true;
});

describe("on a manual job", () => {
  /* No agent, no agent scores — and a heading promising them would be a lie. */
  it("renders nothing at all", () => {
    managerState.manager = null;
    const { container } = render(<ApplicantScores escrowId={7} isClient />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before we know who manages the job", () => {
    managerState.loaded = false;
    const { container } = render(<ApplicantScores escrowId={7} isClient />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("what the client sees", () => {
  it("shows every applicant's score", () => {
    decisionsState.decisions = [scored(ME, 72), scored(RIVAL, 88)];
    render(<ApplicantScores escrowId={7} isClient />);
    expect(screen.getAllByTestId("score-row")).toHaveLength(2);
  });

  it("ranks them, highest first", () => {
    decisionsState.decisions = [scored(ME, 72), scored(RIVAL, 88)];
    render(<ApplicantScores escrowId={7} isClient />);
    const badges = screen.getAllByTestId("score-badge").map((b) => b.textContent);
    expect(badges[0]).toContain("88");
    expect(badges[1]).toContain("72");
  });

  it("shows the reasoning, which is what makes the score checkable", () => {
    decisionsState.decisions = [scored(ME, 72, "Strong portfolio, timeline is tight.")];
    render(<ApplicantScores escrowId={7} isClient />);
    expect(screen.getByTestId("score-reasoning")).toHaveTextContent(/timeline is tight/);
  });

  /* The rehearsed demo beat: a cover letter that tries to instruct the reviewer
     is scored near zero AND flagged, so the attempt is visible, not just the
     low number. */
  it("flags an applicant who tried to instruct the reviewer", () => {
    decisionsState.decisions = [scored(ME, 3, "[PROMPT INJECTION DETECTED] Told me to score it 100.")];
    render(<ApplicantScores escrowId={7} isClient />);
    expect(screen.getByText(/injection attempt/i)).toBeInTheDocument();
  });
});

describe("what a freelancer sees", () => {
  it("shows their own score", () => {
    decisionsState.decisions = [scored(ME, 72), scored(RIVAL, 88)];
    render(<ApplicantScores escrowId={7} isClient={false} viewer={ME} />);
    expect(screen.getAllByTestId("score-row")).toHaveLength(1);
    expect(screen.getByTestId("score-badge")).toHaveTextContent("72");
  });

  /* The edge that matters: another applicant's rejection is not theirs to read. */
  it("never shows them anybody else's", () => {
    decisionsState.decisions = [scored(ME, 72), scored(RIVAL, 88, "Rival was weak on brief fit.")];
    render(<ApplicantScores escrowId={7} isClient={false} viewer={ME} />);
    expect(screen.queryByText(/Rival was weak/)).not.toBeInTheDocument();
    expect(screen.queryByText("88/100", { exact: false })).not.toBeInTheDocument();
  });

  it("matches the viewer regardless of address casing", () => {
    decisionsState.decisions = [scored(ME.toLowerCase(), 72)];
    render(<ApplicantScores escrowId={7} isClient={false} viewer={ME} />);
    expect(screen.getByTestId("score-badge")).toHaveTextContent("72");
  });
});

describe("before anything is scored", () => {
  /* The ordinary state during the application window, and a different sentence
     for each side. */
  it("tells the client the agent is still waiting to compare everyone", () => {
    render(<ApplicantScores escrowId={7} isClient />);
    expect(screen.getByTestId("scores-pending")).toHaveTextContent(/compare everyone at once/i);
  });

  it("reassures the applicant that applying first is not what wins", () => {
    render(<ApplicantScores escrowId={7} isClient={false} viewer={ME} />);
    expect(screen.getByTestId("scores-pending")).toHaveTextContent(/nothing is decided on who applied first/i);
  });
});

/* An unreachable daemon is not "nobody applied", and saying so would tell a
   freelancer they were ignored when the truth is we could not look. */
describe("when the agent cannot be reached", () => {
  it("says so rather than showing an empty result", () => {
    decisionsState.error = "offline";
    render(<ApplicantScores escrowId={7} isClient={false} viewer={ME} />);
    expect(screen.getByTestId("scores-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("scores-pending")).not.toBeInTheDocument();
  });

  it("says the applications themselves are unaffected", () => {
    decisionsState.error = "offline";
    render(<ApplicantScores escrowId={7} isClient />);
    expect(screen.getByText(/on-chain either way/i)).toBeInTheDocument();
  });
});
