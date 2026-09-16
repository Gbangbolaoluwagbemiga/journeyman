import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Escrow, Milestone } from "@/lib/web3/types";

const WALLET_ADDRESS = "0xc11e0000000000000000000000000000000001";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FREELANCER_ADDRESS = "0xfee1000000000000000000000000000000fee1";

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: WALLET_ADDRESS, isConnected: true, balance: "0" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/web3/contract-service", () => ({
  contractService: {
    getRating: vi.fn().mockResolvedValue(null),
    // The apply dialog asks who manages the job, to decide whether there are
    // agent criteria to show. null = the client runs it themselves.
    getJobManager: vi.fn().mockResolvedValue(null),
  },
}));

// Everything below only mounts when the card is expanded — stub it out so
// the Message-button test (which renders collapsed) stays lightweight, and
// so the milestone-mapping test only exercises escrow-card's own prop
// computation, not JobManagement's internals (covered separately).
vi.mock("@/components/milestone-actions", () => ({ MilestoneActions: () => null }));
vi.mock("@/components/milestone-negotiation", () => ({ MilestoneNegotiation: () => null }));
vi.mock("@/components/evidence-submission-button", () => ({ EvidenceSubmissionButton: () => null }));
vi.mock("@/components/view-evidence-button", () => ({ ViewEvidenceButton: () => null }));
vi.mock("@/components/rating/rating-dialog", () => ({ RatingDialog: () => null }));
// Same reason as the stubs above, plus one of its own: AutopilotControl reads
// the job manager through wagmi's useWriteContract, so mounting it for real
// would make this file require a WagmiProvider to test milestone prop mapping.
// Its own behaviour is covered in test/atelier/autopilot-control.test.tsx.
vi.mock("@/components/atelier/autopilot-control", () => ({ AutopilotControl: () => null }));
vi.mock("@/components/atelier/job-decision-log", () => ({ JobDecisionLog: () => null }));
// Same reason as the two above: it opens a wagmi write, and this suite renders
// the card without a WagmiProvider because it is testing prop plumbing, not chain calls.
vi.mock("@/components/atelier/post-dispute-choice", () => ({ PostDisputeChoice: () => null }));
vi.mock("@/components/atelier/yield-opt-in", () => ({ YieldOptIn: () => null }));

/*
 * Mock wagmi itself rather than stubbing each child that reaches for it.
 *
 * This file has broken twice now for the same reason: a new child of EscrowCard
 * calls useWriteContract, there is no provider here, and the whole card fails to
 * render — taking down two tests about milestone requirements that have nothing
 * to do with the new child. Stubbing children one at a time only defers the
 * next one.
 */
vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useAccount: () => ({ address: undefined, isConnected: false }),
  usePublicClient: () => undefined,
}));
vi.mock("@/components/chat/chat-dialog", () => ({
  ChatDialog: ({ otherAddress }: { otherAddress: string }) => (
    <div data-testid="chat-dialog" data-other={otherAddress} />
  ),
}));

const jobManagementSpy = vi.fn();
vi.mock("@/components/job-management", () => ({
  JobManagement: (props: any) => {
    jobManagementSpy(props);
    return <div data-testid="job-management-mock" />;
  },
}));

const { EscrowCard } = await import("@/components/dashboard/escrow-card");

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    description: "",
    amount: "1000000",
    status: "pending",
    ...overrides,
  };
}

function makeEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: "1",
    payer: WALLET_ADDRESS,
    beneficiary: ZERO_ADDRESS,
    token: "0xUSDC",
    totalAmount: "1000000",
    releasedAmount: "0",
    status: "pending",
    createdAt: Date.now(),
    duration: 7 * 24 * 60 * 60,
    milestones: [],
    projectTitle: "Landing Page Redesign",
    isClient: true,
    isFreelancer: false,
    ...overrides,
  };
}

function requiredProps() {
  return {
    index: 0,
    submittingMilestone: null,
    onToggleExpanded: vi.fn(),
    onApproveMilestone: vi.fn(),
    onRejectMilestone: vi.fn(),
    onDisputeMilestone: vi.fn(),
    onStartWork: vi.fn(),
    onDispute: vi.fn(),
    calculateDaysLeft: () => 3,
    getDaysLeftMessage: () => ({ text: "3 days left", color: "", bgColor: "" }),
  };
}

beforeEach(() => {
  jobManagementSpy.mockClear();
});

describe("EscrowCard — Message-button zero-address gating (fixed bug: appeared for unassigned jobs)", () => {
  it("does NOT show 'Message' when the job has no real freelancer assigned yet", () => {
    render(
      <EscrowCard
        escrow={makeEscrow({ beneficiary: ZERO_ADDRESS })}
        expandedEscrow={null}
        {...requiredProps()}
      />,
    );
    expect(screen.queryByRole("button", { name: /message/i })).not.toBeInTheDocument();
  });

  it("shows 'Message' once a real freelancer is assigned", () => {
    render(
      <EscrowCard
        escrow={makeEscrow({ beneficiary: FREELANCER_ADDRESS })}
        expandedEscrow={null}
        {...requiredProps()}
      />,
    );
    expect(screen.getByRole("button", { name: /message/i })).toBeInTheDocument();
  });

  it("opens a chat with the assigned freelancer's real address, not the zero address", async () => {
    const user = userEvent.setup();
    render(
      <EscrowCard
        escrow={makeEscrow({ beneficiary: FREELANCER_ADDRESS })}
        expandedEscrow={null}
        {...requiredProps()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /message/i }));
    expect(screen.getByTestId("chat-dialog")).toHaveAttribute("data-other", FREELANCER_ADDRESS);
  });
});

describe("EscrowCard — milestone requirements fallback fed to JobManagement (fixed bug: description missing in Add/Withdraw Funds)", () => {
  it("prefers on-chain `requirements` over the (possibly-overwritten) `description`", () => {
    const escrow = makeEscrow({
      beneficiary: ZERO_ADDRESS,
      milestones: [
        makeMilestone({
          requirements: "Build the responsive navbar",
          description: "done, check it out boss", // overwritten by freelancer's submission
        }),
      ],
    });
    render(<EscrowCard escrow={escrow} expandedEscrow="1" {...requiredProps()} />);

    expect(jobManagementSpy).toHaveBeenCalled();
    const passedMilestones = jobManagementSpy.mock.calls.at(-1)![0].milestones;
    expect(passedMilestones[0].description).toBe("Build the responsive navbar");
  });

  it("falls back to originalDescription, then the raw body, when requirements is absent", () => {
    const escrow = makeEscrow({
      beneficiary: ZERO_ADDRESS,
      milestones: [
        makeMilestone({ requirements: undefined, originalDescription: "Cached original brief" }),
        makeMilestone({ requirements: undefined, originalDescription: undefined, description: "Raw brief text" }),
      ],
    });
    render(<EscrowCard escrow={escrow} expandedEscrow="1" {...requiredProps()} />);

    const passedMilestones = jobManagementSpy.mock.calls.at(-1)![0].milestones;
    expect(passedMilestones[0].description).toBe("Cached original brief");
    expect(passedMilestones[1].description).toBe("Raw brief text");
  });
});
