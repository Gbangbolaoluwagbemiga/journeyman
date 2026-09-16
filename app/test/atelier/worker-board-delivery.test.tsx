import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * SENDING THE WORK — the step a hired freelancer could not take.
 *
 * The board listed a hired job with the line "You were hired — send your work"
 * and offered nothing to send it with. The daemon endpoint existed, the client
 * function existed, and the row was display-only, so the only way to deliver
 * from the web was to go and use the Telegram bot instead.
 */

const myWork = vi.fn();
const quests = vi.fn();
const me = vi.fn();
const submit = vi.fn();
const deliveryTarget = vi.fn();
const uploadAuth = vi.fn();
const uploadMilestoneFileWithAuth = vi.fn();

vi.mock("@/lib/atelier/worker", () => ({
  myWork: (id: string) => myWork(id),
  quests: (id: string) => quests(id),
  me: (id: string) => me(id),
  submit: (input: unknown) => submit(input),
  deliveryTarget: (id: string) => deliveryTarget(id),
  uploadAuth: (i: unknown) => uploadAuth(i),
  apply: vi.fn(),
  withdraw: vi.fn(),
  minutesUntilClose: () => 0,
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/lib/api", () => ({
  isApiConfigured: () => true,
  uploadMilestoneFileWithAuth: (...a: unknown[]) => uploadMilestoneFileWithAuth(...a),
}));

const { WorkerBoard } = await import("@/components/atelier/worker-board");

const WORKER = {
  id: "w1",
  handle: "cdev",
  address: "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423",
  mode: "managed",
  balance: "0.05",
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  quests.mockResolvedValue([]);
  me.mockResolvedValue(WORKER);
  submit.mockResolvedValue({ txHash: "0xtx" });
  uploadAuth.mockResolvedValue({ address: "0x8289", message: "m", signature: "0xsig", timestamp: "1" });
  uploadMilestoneFileWithAuth.mockResolvedValue({
    url: "https://files.test/logo.png", filename: "logo.png", size: 1024, mimeType: "image/png",
  });
  deliveryTarget.mockResolvedValue({
    escrowId: "7",
    index: 1,
    count: 2,
    description: "Backend script to audit pending status entries",
    amountUsdc: 2,
    criteria: ["Screenshot confirming the role update", "No new issues introduced"],
    agentReviewed: true,
    previousFeedback: null,
  });
  myWork.mockResolvedValue([
    { escrowId: "7", title: "fireball", budget: 5, status: "You were hired — send your work", icon: "🔨", state: "hired" },
  ]);
});

describe("a hired freelancer delivering", () => {
  it("offers a way to send the work, not just a line telling them to", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: /send work/i })).toBeInTheDocument();
  });

  it("submits what they wrote, letting the daemon pick the milestone", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "Figma link: example.com/f");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    const arg = submit.mock.calls[0][0];
    expect(arg).toMatchObject({ workerId: "w1", escrowId: "7", description: "Figma link: example.com/f" });
    // Hard-coding 0 filed a second milestone's delivery against the first.
    expect(arg.milestoneIndex).toBeUndefined();
  });

  it("will not send an empty delivery", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(screen.getByRole("button", { name: /submit for review/i })).toBeDisabled();
  });

  it("says the work is on-chain and awaiting review", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "Done");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].title).toMatch(/submitted/i);
  });

  it("offers nothing to send on a job that is finished and paid", async () => {
    myWork.mockResolvedValue([
      { escrowId: "7", title: "fireball", budget: 5, status: "Finished and paid", icon: "✅", state: "completed" },
    ]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("fireball")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });

  it("offers nothing to send on a job they only applied for", async () => {
    myWork.mockResolvedValue([
      { escrowId: "9", title: "other", budget: 2, status: "Applied, waiting on the agent", icon: "⏳", state: "applied" },
    ]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("other")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });
});


/**
 * TELLING THEM WHAT THEY ARE DELIVERING, AND WHAT IT FACES.
 *
 * The box asked "What did you deliver?" and nothing else. On a two-stage job it
 * silently chose a milestone; on an agent-run job a machine then approved or
 * rejected the answer against criteria the freelancer had never been shown.
 */
describe("what the delivery box tells them", () => {
  it("names the stage and its share of the money", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/milestone 2 of 2/i)).toBeInTheDocument();
    expect(screen.getByText(/audit pending status entries/i)).toBeInTheDocument();
    expect(screen.getByText("$2")).toBeInTheDocument();
  });

  it("shows the criteria, and says an agent is the one marking them", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/an agent approves or rejects against/i)).toBeInTheDocument();
    expect(screen.getByText(/Screenshot confirming the role update/)).toBeInTheDocument();
  });

  it("attributes the criteria to the client when no agent reviews", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 0, count: 1, description: "The whole job",
      amountUsdc: 5, criteria: ["Delivered as SVG"], agentReviewed: false,
    });
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/the client is looking for/i)).toBeInTheDocument();
    expect(screen.queryByText(/an agent approves/i)).not.toBeInTheDocument();
  });

  it("says the other stages stay funded, so nobody thinks this ends the job", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/the rest stay\s+funded/i)).toBeInTheDocument();
  });

  it("does not claim a stage count on a single-stage job", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 0, count: 1, description: "The whole job",
      amountUsdc: 5, criteria: [], agentReviewed: false,
    });
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/pays in one stage/i)).toBeInTheDocument();
    expect(screen.queryByText(/milestone 1 of/i)).not.toBeInTheDocument();
  });

  it("still lets them deliver when the detail cannot be loaded", async () => {
    // Better to submit without the context than to be unable to submit at all.
    deliveryTarget.mockRejectedValue(new Error("offline"));
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "Done");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
  });
});


/**
 * WAITING, WITHOUT WORRYING.
 *
 * A stage with the reviewer and a stage nobody has looked at are the same
 * silence from the freelancer's side. So is an agent that answers in minutes
 * and a client who answers when they next open the tab. The board said nothing
 * about any of it, and let them send the next stage anyway — which is how
 * somebody delivers twice without ever receiving a verdict.
 */
describe("a stage already with the reviewer", () => {
  const WAITING = {
    escrowId: "7", title: "fireball", budget: 5,
    status: "1 with the reviewer — the next stage opens once this one is decided",
    icon: "⏳", state: "hired", awaitingReview: 1, approved: 0, needsRevision: 0,
    milestoneCount: 2, canSubmit: false, reviewer: "agent" as const,
  };

  it("holds the button rather than inviting a second delivery", async () => {
    myWork.mockResolvedValue([WAITING]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("fireball")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });

  it("says an agent is reviewing, and that it is quick", async () => {
    myWork.mockResolvedValue([WAITING]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/autopilot is reviewing/i)).toBeInTheDocument();
    expect(screen.getByText(/few minutes/i)).toBeInTheDocument();
  });

  it("warns that a human reviewer can take longer", async () => {
    myWork.mockResolvedValue([{ ...WAITING, reviewer: "client" }]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/client reviews this one themselves/i)).toBeInTheDocument();
  });
});

describe("a stage sent back for changes", () => {
  const SENT_BACK = {
    escrowId: "7", title: "fireball", budget: 5,
    status: "Changes requested — revise and send it again",
    icon: "✏️", state: "hired", awaitingReview: 0, approved: 0, needsRevision: 1,
    milestoneCount: 2, canSubmit: true, reviewer: "agent" as const,
  };

  it("lets them send again, and says the money is still theirs to win", async () => {
    myWork.mockResolvedValue([SENT_BACK]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByRole("button", { name: /send work/i })).toBeInTheDocument();
    expect(screen.getByText(/still locked in escrow for you/i)).toBeInTheDocument();
  });

  it("shows the reviewer's reason — the only part they can act on", async () => {
    myWork.mockResolvedValue([SENT_BACK]);
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 0, count: 2, description: "Stage one",
      amountUsdc: 3, criteria: [], agentReviewed: true,
      previousFeedback: "No deliverable was included — send a link to the work itself.",
    });

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/why this came back/i)).toBeInTheDocument();
    expect(screen.getByText(/send a link to the work itself/i)).toBeInTheDocument();
  });
});

/**
 * THE VERDICT, CRITERION BY CRITERION.
 *
 * The reviewer produced this every time and stored it every time. The
 * freelancer — the only person who can act on it — saw a status change and
 * nothing else. "Changes requested" tells you that you failed; this tells you
 * what to fix.
 */
describe("what the reviewer actually decided", () => {
  const REVIEWED = {
    escrowId: "7", index: 0, count: 2, description: "Stage one",
    amountUsdc: 3, criteria: ["A", "B"], agentReviewed: true,
    previousFeedback: "No deliverable was included.",
    lastReview: {
      approved: false,
      score: 25,
      criteriaResults: [
        { criterion: "Discord role is removed", passed: false, note: "No deliverable was provided." },
        { criterion: "Screenshot is provided", passed: true, note: "Taken on the freelancer's word." },
      ],
    },
  };

  beforeEach(() => {
    myWork.mockResolvedValue([{
      escrowId: "7", title: "fireball", budget: 5,
      status: "Changes requested — revise and send it again",
      icon: "✏️", state: "hired", awaitingReview: 0, approved: 0,
      needsRevision: 1, milestoneCount: 2, canSubmit: true, reviewer: "agent",
    }]);
    deliveryTarget.mockResolvedValue(REVIEWED);
  });

  it("marks each criterion pass or fail, with the reviewer's note", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/checked.*each criterion/i)).toBeInTheDocument();
    expect(screen.getByText("Discord role is removed")).toBeInTheDocument();
    expect(screen.getByText("No deliverable was provided.")).toBeInTheDocument();
    expect(screen.getByText("Taken on the freelancer's word.")).toBeInTheDocument();
  });

  it("shows the score and says what to do next", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText("25/100")).toBeInTheDocument();
    expect(screen.getByText(/fix the ones marked/i)).toBeInTheDocument();
    // And that not delivering again does not cost them the job.
    expect(screen.getByText(/budget\s+stays locked in escrow/i)).toBeInTheDocument();
  });

  it("says the client checked it when no agent is on the job", async () => {
    deliveryTarget.mockResolvedValue({ ...REVIEWED, agentReviewed: false });
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/the client checked/i)).toBeInTheDocument();
  });

  it("falls back to the plain criteria list before any verdict exists", async () => {
    deliveryTarget.mockResolvedValue({ ...REVIEWED, lastReview: null });
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/an agent approves or rejects against/i)).toBeInTheDocument();
    expect(screen.queryByText("25/100")).not.toBeInTheDocument();
  });
});

/**
 * ONE HALF AT A TIME.
 *
 * "What do I owe" and "what could I take on" are different questions, asked at
 * different moments. Stacked they read as one long list and the committed work
 * scrolls off the top as soon as a few jobs are open; side by side each gets
 * half a screen it does not need.
 */
describe("switching between work and the open board", () => {
  it("shows the work tab by default when there is work on the bench", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("fireball")).toBeVisible();
    expect(screen.getByRole("tab", { name: /your work/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens on the job board when the bench is empty", async () => {
    // The useful answer on a first visit is "here is what you could take on",
    // not an empty panel.
    myWork.mockResolvedValue([]);
    quests.mockResolvedValue([
      { escrowId: "9", title: "A job", budget: 3, durationDays: 2, criteria: [], milestones: [], applied: false },
    ]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /open jobs/i })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("lets them switch, and keeps a half-typed delivery when they come back", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "half a sentence");

    await userEvent.click(screen.getByRole("tab", { name: /open jobs/i }));
    await userEvent.click(screen.getByRole("tab", { name: /your work/i }));

    // Both panels stay mounted on purpose — losing a draft to a tab click is
    // the kind of thing people do not forgive.
    expect(screen.getByRole("textbox")).toHaveValue("half a sentence");
  });

  it("says the bench is empty rather than showing a blank panel", async () => {
    myWork.mockResolvedValue([]);
    quests.mockResolvedValue([]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: /your work/i }));

    expect(screen.getByText(/nothing on your bench/i)).toBeInTheDocument();
  });
});


/**
 * SENDING THE WORK ITSELF.
 *
 * A designer delivering a logo had no way to send the logo — this box took a
 * sentence, and the only route for a file was the Telegram bot. Meanwhile the
 * agent reviewing it has a vision model and was being handed prose about an
 * image it could have opened, then failing the submission for having no
 * deliverable. Which is exactly what happened on escrow 7.
 */
describe("attaching a file", () => {
  const open = async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
  };

  const pick = async (name = "logo.png", type = "image/png") => {
    const input = document.getElementById("file-7") as HTMLInputElement;
    await userEvent.upload(input, new File(["x"], name, { type }));
  };

  it("offers a way to attach, and says the reviewer opens it", async () => {
    await open();
    expect(await screen.findByRole("button", { name: /attach a file/i })).toBeInTheDocument();
    expect(screen.getByText(/the reviewer\s+opens it/i)).toBeInTheDocument();
  });

  it("shows what is attached, and lets it be removed", async () => {
    await open();
    await pick();

    expect(await screen.findByText("logo.png")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove file/i }));
    expect(screen.queryByText("logo.png")).not.toBeInTheDocument();
  });

  it("uploads against the stage being delivered, then appends it to the submission", async () => {
    await open();
    await pick();
    await userEvent.type(screen.getByRole("textbox"), "The logo, final.");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());

    // Signed for milestone 2 — the one actually in flight, not index 0.
    expect(uploadAuth).toHaveBeenCalledWith({ workerId: "w1", escrowId: "7", milestoneIndex: 1 });
    // In the form the client's card and the agent's reviewer already read.
    expect(submit.mock.calls[0][0].description).toContain(
      "[Attachment: logo.png](https://files.test/logo.png)",
    );
  });

  it("treats a file on its own as a delivery", async () => {
    // Sometimes the work IS the file and there is nothing to say about it.
    await open();
    expect(screen.getByRole("button", { name: /submit for review/i })).toBeDisabled();

    await pick();
    expect(screen.getByRole("button", { name: /submit for review/i })).toBeEnabled();
  });

  it("does not submit when the upload fails", async () => {
    // The file IS the deliverable. Sending the sentence without it puts work in
    // front of a reviewer with the evidence missing, and it gets rejected for
    // exactly that.
    uploadMilestoneFileWithAuth.mockRejectedValue(new Error("storage is down"));

    await open();
    await pick();
    await userEvent.type(screen.getByRole("textbox"), "Here it is.");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(uploadMilestoneFileWithAuth).toHaveBeenCalled());
    expect(submit).not.toHaveBeenCalled();
  });

  it("still sends a plain text delivery when nothing is attached", async () => {
    await open();
    await userEvent.type(screen.getByRole("textbox"), "Done, see the repo.");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(uploadAuth).not.toHaveBeenCalled();
    expect(submit.mock.calls[0][0].description).toBe("Done, see the repo.");
  });
});


/**
 * A TRACK RECORD, FOR THE SIDE THAT ARRIVES WITHOUT ONE.
 *
 * The client's dashboard has always carried finished counts and a rating. A
 * managed worker saw a balance and a list of tasks — and they are the half of
 * the marketplace that most needs somewhere to build a reputation, because they
 * turned up with no wallet and no history at all.
 */
describe("the standing facts about a worker", () => {
  it("counts what is finished, running and still waiting on a decision", async () => {
    myWork.mockResolvedValue([
      { escrowId: "1", title: "a", budget: 1, status: "", icon: "", state: "completed" },
      { escrowId: "2", title: "b", budget: 1, status: "", icon: "", state: "hired", canSubmit: true },
      { escrowId: "3", title: "c", budget: 1, status: "", icon: "", state: "applied" },
      { escrowId: "4", title: "d", budget: 1, status: "", icon: "", state: "lost" },
    ]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    const finished = (await screen.findByText("Finished")).parentElement!;
    expect(finished).toHaveTextContent("1");
    expect(screen.getByText("In progress").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Applied").parentElement).toHaveTextContent("1");
  });

  it("shows the rating once there is one", async () => {
    render(
      <WorkerBoard
        worker={{ ...WORKER, rating: { average: 4.5, count: 2 } } as never}
        onWorkerChanged={() => {}}
      />,
    );

    expect(await screen.findByText("4.5")).toBeInTheDocument();
    expect(screen.getByText("2 jobs rated")).toBeInTheDocument();
  });

  it("says a first-timer's rating is still to come, not zero", async () => {
    // A row of zeroes should read as a starting point, not a verdict.
    render(
      <WorkerBoard
        worker={{ ...WORKER, rating: { average: 0, count: 0 } } as never}
        onWorkerChanged={() => {}}
      />,
    );

    expect(await screen.findByText("after your first job")).toBeInTheDocument();
    expect(screen.getByText("Rating").parentElement).toHaveTextContent("—");
  });

  it("draws nothing rather than failing when the rating cannot be read", async () => {
    render(<WorkerBoard worker={{ ...WORKER, rating: null } as never} onWorkerChanged={() => {}} />);
    expect(await screen.findByText("Rating")).toBeInTheDocument();
  });
});


/**
 * HOW A FINISHED JOB ENDED.
 *
 * The row had no way to open, so a freelancer whose milestone had been through
 * a dispute could see that it was over and never what had been decided. The
 * split is on-chain; the arbiter's written reasoning is not — it is saved to
 * the resolver's own browser — so the money is what can honestly be shown.
 */
describe("opening a finished job", () => {
  const DONE = {
    escrowId: "7", title: "fireball", budget: 3,
    status: "All 2 stage(s) approved and paid", icon: "✅", state: "completed",
    awaitingReview: 0, approved: 2, needsRevision: 0, milestoneCount: 2,
    canSubmit: false, reviewer: "agent" as const,
  };

  beforeEach(() => myWork.mockResolvedValue([DONE]));

  it("offers a way to see how it ended", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: /see how this ended/i })).toBeInTheDocument();
    // And never a way to send more work into a finished job.
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });

  it("shows the arbiter's split, from the chain", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 1, count: 2, description: "Stage two", amountUsdc: 2,
      criteria: [], agentReviewed: true, previousFeedback: null, lastReview: null,
      disputeOutcome: { freelancerUsdc: 0, clientUsdc: 2 },
    });

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /see how this ended/i }));

    expect(await screen.findByText(/an arbiter decided this stage/i)).toBeInTheDocument();
    expect(screen.getByText("Returned to the client").parentElement).toHaveTextContent("$2");
  });

  it("shows the arbiter's own words, now that there is somewhere to keep them", async () => {
    // The reason used to live in the resolver's localStorage and nowhere else,
    // so the freelancer whose payment it decided could never read it. It is
    // recorded against the milestone now, and this is the person it is about.
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 1, count: 2, description: "Stage two", amountUsdc: 2,
      criteria: [], agentReviewed: true, previousFeedback: null, lastReview: null,
      disputeOutcome: {
        freelancerUsdc: 0,
        clientUsdc: 2,
        reason: "No deliverable was ever provided across three revision rounds.",
      },
    });

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /see how this ended/i }));

    expect(await screen.findByText(/why they decided that/i)).toBeInTheDocument();
    expect(screen.getByText(/three revision rounds/i)).toBeInTheDocument();
  });

  it("says none was recorded, for a dispute settled before there was anywhere to put it", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 1, count: 2, description: "Stage two", amountUsdc: 2,
      criteria: [], agentReviewed: true, previousFeedback: null, lastReview: null,
      disputeOutcome: { freelancerUsdc: 0, clientUsdc: 2, reason: null },
    });

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /see how this ended/i }));

    expect(await screen.findByText(/did not record a written reason/i)).toBeInTheDocument();
  });

  it("says it was simply approved when no arbiter was involved", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 1, count: 2, description: "Stage two", amountUsdc: 2,
      criteria: [], agentReviewed: true, previousFeedback: null, lastReview: null,
      disputeOutcome: null,
    });

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /see how this ended/i }));

    expect(await screen.findByText(/approved and paid in full/i)).toBeInTheDocument();
  });
});

/**
 * A JOB MUST NEVER JUST DISAPPEAR.
 *
 * The subgraph was rate-limited, the chain fallback was refused, the hire list
 * came back empty, and a freelancer's finished job vanished off their board
 * with nothing to say why. Their work and their money both looked gone. It is
 * the worst thing this page can do, and the read was a `.catch(() => [])`.
 */
describe("when the board cannot be loaded", () => {
  const JOB = {
    escrowId: "7", title: "fireball", budget: 3, status: "All 2 stage(s) approved and paid",
    icon: "✅", state: "completed", awaitingReview: 0, approved: 2, needsRevision: 0,
    milestoneCount: 2, canSubmit: false, reviewer: "agent" as const,
  };

  it("keeps showing what it had, rather than emptying the list", async () => {
    myWork.mockResolvedValueOnce([JOB]).mockRejectedValue(new Error("read problem"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    expect(await screen.findByText("fireball")).toBeInTheDocument();

    // The board polls; a failed poll must not take the job off the screen.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("fireball")).toBeInTheDocument();
  });

  it("says the list is incomplete, not that the bench is empty", async () => {
    myWork.mockRejectedValue(new Error("read problem"));
    quests.mockResolvedValue([]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: /your work/i }));

    expect(await screen.findByText(/incomplete rather than empty/i)).toBeInTheDocument();
    // And reassures them about the part that actually matters.
    expect(screen.getByText(/on-chain either way/i)).toBeInTheDocument();
  });

  it("says the bench is empty when that is genuinely the answer", async () => {
    myWork.mockResolvedValue([]);
    quests.mockResolvedValue([]);

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: /your work/i }));

    expect(await screen.findByText(/nothing on your bench/i)).toBeInTheDocument();
  });
});
