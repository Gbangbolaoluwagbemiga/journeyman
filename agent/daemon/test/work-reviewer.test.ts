import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AcceptanceBrief } from "../src/web3/types.js";

/**
 * THE SECOND DECISION THAT MOVES SOMEBODY'S MONEY.
 *
 * The scorer decides who gets hired. This decides whether they get paid, and it
 * had no test at all. Both directions are expensive and they are expensive in
 * different ways:
 *
 *   approving work nobody could open  →  the client pays for nothing
 *   rejecting work nobody could check →  the freelancer is not paid for work
 *                                        they may well have done
 *
 * Most of what is guarded below is the second kind, because it is the one a
 * marketplace gets wrong by default. "I could not confirm this" is a note, not
 * a failure — you do not withhold someone's pay because a host was slow.
 *
 * Every one of these came from a model behaving differently from the last one.
 * That is the whole point: the guards live in code precisely so that whether
 * Atelier pays does not depend on the model of the day.
 */

const groqStructured = vi.fn();
const inspectDeliverable = vi.fn();

vi.mock("../src/groq/structured.js", () => ({ groqStructured }));
vi.mock("../src/agent/VisionReviewer.js", () => ({ inspectDeliverable }));
vi.mock("../src/config.js", () => ({
  config: { groqModel: "m", groqFallbackModel: "f", groqApiKey: "k" },
}));

const { reviewWork, buildRevisionRequest, shouldEscalateToHuman } = await import(
  "../src/agent/WorkReviewer.js"
);

const brief = {
  title: "A logo",
  criteria: ["SVG export", "Under three colours"],
  deliverableFormat: "SVG and PNG",
} as unknown as AcceptanceBrief;

/** What the model said, before any of our guards run. */
function modelSays(over: Record<string, unknown> = {}) {
  groqStructured.mockResolvedValue({
    approved: true,
    score: 90,
    reasoning: "Meets the brief.",
    feedback: "",
    criteriaResults: [
      { criterion: "SVG export", passed: true, note: "Present." },
      { criterion: "Under three colours", passed: true, note: "Two." },
    ],
    ...over,
  });
}

/** What the inspector managed to do with the delivered file. */
function inspection(over: Record<string, unknown> = {}) {
  inspectDeliverable.mockResolvedValue({
    available: true,
    description: "A two-colour vector mark.",
    findings: [],
    note: "",
    inspectionBlockedByHost: false,
    ...over,
  });
}

const LINK = "https://example.com/logo.svg";

beforeEach(() => {
  groqStructured.mockReset();
  inspectDeliverable.mockReset();
  modelSays();
  inspection();
});

describe("the ordinary paths", () => {
  it("approves work that meets the brief", async () => {
    const r = await reviewWork("Here it is.", LINK, brief, "Final files");
    expect(r.approved).toBe(true);
    expect(r.score).toBe(90);
  });

  it("passes a rejection through with its feedback intact", async () => {
    modelSays({ approved: false, score: 40, feedback: "Four colours, brief says three." });
    const r = await reviewWork("Here it is.", LINK, brief, "Final files");
    expect(r.approved).toBe(false);
    expect(r.feedback).toContain("brief says three");
  });

  it("records whether the file was actually opened, for the arbiter", async () => {
    const r = await reviewWork("Here it is.", LINK, brief, "Final files");
    expect(r.inspectedArtifact).toBe(true);
  });
});

/**
 * A submission with no link at all is the one case where approval is plainly
 * wrong: there is nothing to check against any criterion.
 */
describe("a submission with no deliverable in it", () => {
  it("is not approved, whatever the model said", async () => {
    const r = await reviewWork("I finished the logo, it looks great.", "", brief, "Final files");
    expect(r.approved).toBe(false);
  });

  it("says what is missing rather than judging the work", async () => {
    const r = await reviewWork("I finished it.", "", brief, "Final files");
    expect(r.feedback).toMatch(/no deliverable was included/i);
    expect(r.feedback).toMatch(/money stays locked in escrow/i);
  });

  it("marks every criterion unchecked rather than failed on the merits", async () => {
    const r = await reviewWork("I finished it.", "", brief, "Final files");
    expect(r.criteriaResults.every((c) => !c.passed)).toBe(true);
    expect(r.criteriaResults.every((c) => /could not be checked/i.test(c.note))).toBe(true);
  });

  /* A rejection that was already a rejection must not be made worse by this. */
  it("leaves an existing rejection alone", async () => {
    modelSays({ approved: false, score: 10, feedback: "Nothing here." });
    const r = await reviewWork("I finished it.", "", brief, "Final files");
    expect(r.score).toBe(10);
  });
});

/**
 * The model once approved a submission at 100/100 whose only link was an x.com
 * URL that serves no readable content to any automated reader. It had inspected
 * nothing and paid out anyway.
 */
describe("a deliverable nobody could open", () => {
  beforeEach(() => inspection({ available: false, inspectionBlockedByHost: true, note: "Host blocks readers." }));

  it("is not paid out on", async () => {
    const r = await reviewWork("It's on my profile.", "https://x.com/me/status/1", brief, "Final files");
    expect(r.approved).toBe(false);
  });

  /* The distinction that matters: this is our limitation, not their failure.
     The score is untouched and no criterion is marked failed. */
  it("does not count against the freelancer", async () => {
    const r = await reviewWork("It's on my profile.", "https://x.com/me/status/1", brief, "Final files");
    expect(r.score).toBe(90);
    expect(r.criteriaResults.every((c) => c.passed)).toBe(true);
  });

  it("says so, and says what to do instead", async () => {
    const r = await reviewWork("It's on my profile.", "https://x.com/me/status/1", brief, "Final files");
    expect(r.feedback).toMatch(/limitation on our side/i);
    expect(r.feedback).toMatch(/nothing here counts against you/i);
    expect(r.feedback).toMatch(/re-send it somewhere readable/i);
  });

  it("carries why it could not be read, so an arbiter can see it", async () => {
    const r = await reviewWork("It's on my profile.", "https://x.com/me/status/1", brief, "Final files");
    expect(r.inspectedArtifact).toBe(false);
    expect(r.inspectionNote).toBe("Host blocks readers.");
  });
});

/**
 * Being unable to inspect is NOT the same as being blocked. A slow host, an
 * unrasterisable format, no vision model configured — none of those are the
 * freelancer's doing, and none of them should stop a payment on their own.
 */
describe("when inspection simply was not possible", () => {
  it("still approves, rather than withholding pay over our own limits", async () => {
    inspection({ available: false, inspectionBlockedByHost: false, note: "No vision model configured." });
    const r = await reviewWork("Here it is.", LINK, brief, "Final files");
    expect(r.approved).toBe(true);
  });

  it("records that nothing was inspected, so nobody reads it as verified", async () => {
    inspection({ available: false, inspectionBlockedByHost: false, note: "No vision model configured." });
    const r = await reviewWork("Here it is.", LINK, brief, "Final files");
    expect(r.inspectedArtifact).toBe(false);
  });
});

describe("what the freelancer is sent back", () => {
  it("leads with the actionable feedback and the rounds left", () => {
    const text = buildRevisionRequest(
      {
        approved: false, score: 55, reasoning: "Close.",
        feedback: "Export at 2400px.",
        criteriaResults: [{ criterion: "SVG export", passed: false, note: "PNG only." }],
      },
      2,
    );
    expect(text).toContain("Export at 2400px.");
    expect(text).toContain("2 revision rounds remaining");
    expect(text).toContain("✗ SVG export — PNG only.");
  });

  it("says round rather than rounds when there is one left", () => {
    const text = buildRevisionRequest(
      { approved: false, score: 55, reasoning: "", feedback: "Fix it.", criteriaResults: [] },
      1,
    );
    expect(text).toContain("1 revision round remaining");
    expect(text).not.toContain("1 revision rounds");
  });
});

/**
 * Escalation counts rejections against a FIXED maximum from the brief. It was
 * once counted against a shrinking remainder, which escalated someone who had
 * visibly improved between submissions.
 */
describe("when a human has to decide instead", () => {
  const rejected = { approved: false, score: 40, reasoning: "", feedback: "", criteriaResults: [] };
  const approved = { approved: true, score: 90, reasoning: "", feedback: "", criteriaResults: [] };

  it("does not escalate before the rounds are used up", () => {
    expect(shouldEscalateToHuman([rejected, rejected], 3)).toBe(false);
  });

  it("escalates once they are", () => {
    expect(shouldEscalateToHuman([rejected, rejected, rejected], 3)).toBe(true);
  });

  it("counts rejections only, not every review in the history", () => {
    expect(shouldEscalateToHuman([approved, rejected, approved], 2)).toBe(false);
  });

  it("never escalates a first submission", () => {
    expect(shouldEscalateToHuman([], 3)).toBe(false);
  });
});
