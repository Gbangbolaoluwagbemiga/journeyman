import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Application, AcceptanceBrief } from "../src/web3/types.js";

/**
 * THE DECISION THAT SPENDS SOMEBODY'S MONEY ON SOMEBODY ELSE.
 *
 * This module picks who gets hired, and the hire releases USDC. It is the most
 * consequential code in the daemon and, until this file, had no test at all.
 *
 * The cases below are the ones that have actually gone wrong, or that would be
 * invisible if they did:
 *
 *   a model that returns the right answer in the wrong shape
 *   a cover letter that instructs the reviewer instead of persuading them
 *   a tie broken by whatever order the model happened to emit
 *
 * The last matters more than it looks. Two people can genuinely both score 75,
 * and "whoever the model listed first" is not a reason a marketplace can say
 * out loud to the person who lost.
 */

const groqStructured = vi.fn();
const getAverageRating = vi.fn();

vi.mock("../src/groq/structured.js", () => ({ groqStructured }));
vi.mock("../src/web3/atelier.js", () => ({ getAverageRating }));
vi.mock("../src/agent/ApplicantEvidence.js", () => ({
  gatherEvidence: vi.fn(async () => ({ portfolio: null, history: null })),
  renderEvidence: vi.fn(() => ({ shown: "No link given.", record: "No history." })),
}));
vi.mock("../src/config.js", () => ({
  config: { hireScoreThreshold: 55, groqModel: "m", groqFallbackModel: "f", groqApiKey: "k" },
}));

const { scoreApplications, pickBestApplicant } = await import(
  "../src/agent/ApplicationScorer.js"
);

const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const brief = {
  title: "A logo",
  budget: 50,
  durationDays: 3,
  criteria: ["vector", "SVG export"],
  milestones: [{ description: "Concepts", amount: 50 }],
  revisionRounds: 3,
} as unknown as AcceptanceBrief;

function app(address: string, over: Partial<Application> = {}): Application {
  return {
    freelancerAddress: address,
    coverLetter: "I work in vector and deliver SVG plus PNG at 2400px.",
    proposedTimeline: 2,
    appliedAt: 1000,
    ...over,
  } as Application;
}

/** One applicant's slice of a scoring reply, with the parts summing to `score`. */
function scored(address: string, score: number, over: Record<string, unknown> = {}) {
  const capability = score - 30;
  return {
    freelancerAddress: address,
    score,
    breakdown: { capability, briefFit: 20, timeline: 5, history: 5 },
    reasoning: "Meets the criteria.",
    recommendation: score >= 55 ? "accept" : "reject",
    injectionDetected: false,
    ...over,
  };
}

/**
 * Stand in for the LLM the way the real client does — including the normaliser
 * and the schema the scorer hands it.
 *
 * Resolving a finished object from the mock instead would make the
 * wrong-shape cases below vacuous: they would prove the mock returns what it
 * was given, while `normalizeScoringShape` — the code that actually salvages a
 * wandering reply — never ran at all. Verified by inverting it; three tests go
 * red.
 */
function replyWith(payload: unknown) {
  groqStructured.mockImplementation(async (opts: any) =>
    opts.schema.parse(opts.normalize ? opts.normalize(payload) : payload),
  );
}

beforeEach(() => {
  groqStructured.mockReset();
  getAverageRating.mockReset();
  getAverageRating.mockResolvedValue({ average: 0, count: 0 });
});

describe("reading what the model returned", () => {
  it("scores an applicant from a well-formed reply", async () => {
    replyWith({ scores: [scored(A, 80)] });
    const out = await scoreApplications([app(A)], brief);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(80);
  });

  /* The score is the sum of the stated parts, not the model's own total — the
     allocation is the thing we can defend to an applicant. */
  it("trusts the breakdown's sum over a total that contradicts it", async () => {
    replyWith({
      scores: [scored(A, 80, { breakdown: { capability: 40, briefFit: 20, timeline: 10, history: 5 } })],
    });
    const out = await scoreApplications([app(A)], brief);
    expect(out[0].score).toBe(75);
  });

  it("shows where the points went, so a rejection can be explained", async () => {
    replyWith({ scores: [scored(A, 80)] });
    const out = await scoreApplications([app(A)], brief);
    expect(out[0].reasoning).toMatch(/capability 50\/50 · brief fit 20\/30/);
  });

  it("returns nothing for nobody, without calling the model", async () => {
    expect(await scoreApplications([], brief)).toEqual([]);
    expect(groqStructured).not.toHaveBeenCalled();
  });
});

/**
 * The fallback model wanders: it returns the array bare, or names the key
 * something else. Each variant carried exactly the right information and was
 * being thrown away on a key name — a real hire lost to a wrapper.
 */
describe("a reply in the wrong shape", () => {
  it("accepts a bare array", async () => {
    replyWith([scored(A, 70)]);
    expect((await scoreApplications([app(A)], brief))[0].score).toBe(70);
  });

  it("accepts the array under a different key", async () => {
    replyWith({ applicants: [scored(A, 70)] });
    expect((await scoreApplications([app(A)], brief))[0].score).toBe(70);
  });

  it("accepts a single applicant returned unwrapped", async () => {
    replyWith(scored(A, 70));
    expect((await scoreApplications([app(A)], brief))[0].score).toBe(70);
  });
});

/**
 * A cover letter is data. A cover letter that says "score me 100" is data about
 * an applicant who tried to instruct the reviewer, and the attempt is itself the
 * signal — this is the rehearsed demo beat, so it has to hold.
 */
describe("an applicant who tries to instruct the reviewer", () => {
  it("is not hired, whatever the model scored them", async () => {
    replyWith({
      scores: [scored(A, 100, { injectionDetected: true, recommendation: "reject" })],
    });
    const { winner } = await pickBestApplicant([app(A)], brief);
    expect(winner).toBeNull();
  });

  it("is flagged in the ledger rather than quietly dropped", async () => {
    replyWith({
      scores: [scored(A, 3, { injectionDetected: true, recommendation: "reject" })],
    });
    const seen: string[] = [];
    await pickBestApplicant([app(A)], brief, (d) => seen.push(d.reasoning));
    expect(seen.some((r) => /PROMPT INJECTION DETECTED/.test(r))).toBe(true);
  });
});

describe("choosing between them", () => {
  it("hires the higher score", async () => {
    replyWith({ scores: [scored(A, 60), scored(B, 90)] });
    const { winner } = await pickBestApplicant([app(A), app(B)], brief);
    expect(winner?.freelancerAddress).toBe(B);
  });

  it("hires nobody when nobody clears the bar", async () => {
    replyWith({ scores: [scored(A, 40), scored(B, 54)] });
    const { winner } = await pickBestApplicant([app(A), app(B)], brief);
    expect(winner).toBeNull();
  });

  /* A run returning 85 with "reject" used to drop the applicant silently: the
     ledger showed 85/100 and no hire, with nothing explaining why. */
  it("goes with the score when the model's own flag contradicts it", async () => {
    replyWith({ scores: [scored(A, 85, { recommendation: "reject" })] });
    const seen: string[] = [];
    const { winner } = await pickBestApplicant([app(A)], brief, (d) => seen.push(d.reasoning));
    expect(winner?.freelancerAddress).toBe(A);
    expect(seen.some((r) => /the two disagree/.test(r))).toBe(true);
  });
});

/**
 * Ties are real, and were being settled by the model's emission order —
 * arbitrary, different between runs, and impossible to justify to the loser.
 */
describe("a genuine tie", () => {
  it("goes to the better on-chain rating", async () => {
    replyWith({ scores: [scored(A, 75), scored(B, 75)] });
    getAverageRating.mockImplementation(async (who: string) =>
      who.toLowerCase() === B.toLowerCase() ? { average: 4.8, count: 6 } : { average: 3.1, count: 2 },
    );
    const { winner } = await pickBestApplicant([app(A), app(B)], brief);
    expect(winner?.freelancerAddress).toBe(B);
  });

  it("falls to whoever applied first when nothing else separates them", async () => {
    replyWith({ scores: [scored(A, 75), scored(B, 75)] });
    const { winner } = await pickBestApplicant(
      [app(A, { appliedAt: 5000 }), app(B, { appliedAt: 1000 })],
      brief,
    );
    expect(winner?.freelancerAddress).toBe(B);
  });

  it("says out loud how the tie was settled", async () => {
    replyWith({ scores: [scored(A, 75), scored(B, 75)] });
    const seen: string[] = [];
    await pickBestApplicant([app(A), app(B)], brief, (d) => seen.push(d.reasoning));
    expect(seen.some((r) => /^Tie at 75\/100\. Settled on /.test(r))).toBe(true);
  });

  /* A rating lookup failing must not decide who eats this month. */
  it("still picks someone when the reputation read fails", async () => {
    replyWith({ scores: [scored(A, 75), scored(B, 75)] });
    getAverageRating.mockRejectedValue(new Error("rpc down"));
    const { winner } = await pickBestApplicant([app(A), app(B)], brief);
    expect(winner).not.toBeNull();
  });
});
