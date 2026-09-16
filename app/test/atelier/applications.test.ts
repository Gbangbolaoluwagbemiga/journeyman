import { describe, it, expect } from "vitest";
import { outcomeOf, pendingOnly, type AppliedJob } from "@/lib/atelier/applications";

/**
 * WHAT HAPPENED TO A JOB YOU APPLIED FOR.
 *
 * Applying was a one-way door: no list of what you had applied to, and no way
 * to tell "the client is still deciding" from "the client picked someone else".
 * A job just went quiet, and quiet reads as rejection to everyone except the
 * person still hoping.
 *
 * The answer is read off the escrow rather than off any record of ours, because
 * the escrow IS the hire — it cannot be stale, and it is right even if every
 * notification we ever sent was lost.
 *
 * The distinctions below are the point. Each one asks something different of
 * the reader: wait, celebrate, apply elsewhere, or none of the above because
 * there was never a decision.
 */

const ME = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOMEONE_ELSE = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ZERO = "0x0000000000000000000000000000000000000000";

const PENDING = 0, IN_PROGRESS = 1, RELEASED = 2, CANCELLED = 6;

describe("still open", () => {
  it("is waiting while nobody has been hired", () => {
    expect(outcomeOf({ beneficiary: ZERO, status: PENDING }, ME)).toBe("waiting");
  });

  it("is waiting when the beneficiary field is empty rather than zero", () => {
    expect(outcomeOf({ beneficiary: "", status: PENDING }, ME)).toBe("waiting");
    expect(outcomeOf({ beneficiary: null, status: PENDING }, ME)).toBe("waiting");
  });
});

describe("decided", () => {
  it("says you got it when the escrow names you", () => {
    expect(outcomeOf({ beneficiary: ME, status: IN_PROGRESS }, ME)).toBe("won");
  });

  /* Addresses come back from the index in whatever case it stored them. A
     checksum mismatch here would tell someone they lost a job they won. */
  it("matches your address regardless of case", () => {
    expect(outcomeOf({ beneficiary: ME.toLowerCase(), status: IN_PROGRESS }, ME)).toBe("won");
    expect(outcomeOf({ beneficiary: ME, status: IN_PROGRESS }, ME.toLowerCase())).toBe("won");
  });

  it("says it went elsewhere when the escrow names somebody else", () => {
    expect(outcomeOf({ beneficiary: SOMEONE_ELSE, status: IN_PROGRESS }, ME)).toBe("passed");
  });

  /* A finished job you were not hired for is still a job you did not get. */
  it("still says it went elsewhere once that job has finished", () => {
    expect(outcomeOf({ beneficiary: SOMEONE_ELSE, status: RELEASED }, ME)).toBe("passed");
  });
});

/**
 * Being turned down and the job evaporating are different news. Merging them
 * tells someone they lost a competition that never actually concluded.
 */
describe("the client changed their mind", () => {
  it("is withdrawn, not passed, when cancelled with nobody hired", () => {
    expect(outcomeOf({ beneficiary: ZERO, status: CANCELLED }, ME)).toBe("withdrawn");
  });

  it("is still passed when it was cancelled after someone else was hired", () => {
    expect(outcomeOf({ beneficiary: SOMEONE_ELSE, status: CANCELLED }, ME)).toBe("passed");
  });
});

/**
 * The index trails the chain, and it has been wrong before. "Waiting" is the
 * safer wrong answer: it tells someone to check back, where "passed" tells them
 * to stop hoping.
 */
describe("when the index cannot answer", () => {
  it("falls back to waiting rather than to a rejection", () => {
    expect(outcomeOf(null, ME)).toBe("waiting");
    expect(outcomeOf(undefined, ME)).toBe("waiting");
    expect(outcomeOf({}, ME)).toBe("waiting");
  });
});

describe("narrowing to what is outstanding", () => {
  const job = (outcome: AppliedJob["outcome"]): AppliedJob => ({
    escrowId: "1", projectTitle: "t", projectDescription: "", category: null,
    totalAmount: "0", deadline: 0, appliedAt: 0, outcome,
  });

  it("keeps only the ones the client has yet to decide", () => {
    const out = pendingOnly([job("waiting"), job("won"), job("passed"), job("withdrawn")]);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe("waiting");
  });

  it("returns nothing when everything has been decided", () => {
    expect(pendingOnly([job("won"), job("passed")])).toEqual([]);
  });
});
