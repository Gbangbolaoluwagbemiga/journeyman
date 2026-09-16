import { describe, it, expect } from "vitest";
import {
  positionFilledMessage,
  unsuccessfulApplicants,
} from "@/lib/atelier/hire-notifications";

/**
 * WHO GETS TOLD THEY DIDN'T GET IT.
 *
 * Everyone who applied is owed the same answer the winner got. Silence teaches
 * an applicant nothing — they cannot tell "still reading" from "gave it to
 * someone else", so they hold the slot open and don't go apply for the next
 * thing.
 *
 * Every case here is a quiet failure: congratulating the winner a second time
 * with a rejection, messaging the client's own wallet, or telling the same
 * person twice because they applied from two devices. None of them throws, and
 * none of them would show up anywhere except in somebody's notification bell.
 */

const WINNER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RUNNER_UP = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const THIRD = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const CLIENT = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

const app = (freelancerAddress: string) => ({ freelancerAddress });

describe("who is on the list", () => {
  it("is everyone who applied except the person hired", () => {
    const out = unsuccessfulApplicants([app(WINNER), app(RUNNER_UP), app(THIRD)], WINNER);
    expect(out).toEqual([RUNNER_UP, THIRD]);
  });

  /* The winner has just been congratulated. A rejection arriving right behind
     it is the single worst thing this function could do. */
  it("never tells the person who got the job that they didn't", () => {
    const out = unsuccessfulApplicants([app(WINNER)], WINNER);
    expect(out).toEqual([]);
  });

  it("excludes the winner however the two addresses are cased", () => {
    const out = unsuccessfulApplicants([app(WINNER.toLowerCase())], WINNER);
    expect(out).toEqual([]);
  });

  /* A client can apply to their own board from a second wallet — the contract
     stops them being hired, not applying. */
  it("does not send the client a rejection for their own job", () => {
    const out = unsuccessfulApplicants([app(RUNNER_UP), app(CLIENT)], WINNER, CLIENT);
    expect(out).toEqual([RUNNER_UP]);
  });

  it("tells someone once even if they applied twice", () => {
    const out = unsuccessfulApplicants([app(RUNNER_UP), app(RUNNER_UP.toLowerCase())], WINNER);
    expect(out).toEqual([RUNNER_UP]);
  });

  /* The API keys rows on the address it is handed, so the casing has to survive
     even though the comparisons are done in lowercase. */
  it("sends the address as it was given, not lowercased", () => {
    expect(unsuccessfulApplicants([app(RUNNER_UP)], WINNER)).toEqual([RUNNER_UP]);
  });
});

describe("when the list is missing or malformed", () => {
  it("returns nobody rather than throwing on an absent list", () => {
    expect(unsuccessfulApplicants(null, WINNER)).toEqual([]);
    expect(unsuccessfulApplicants(undefined, WINNER)).toEqual([]);
    expect(unsuccessfulApplicants([], WINNER)).toEqual([]);
  });

  it("skips an entry with no address instead of sending to an empty string", () => {
    const out = unsuccessfulApplicants(
      [app(RUNNER_UP), { freelancerAddress: "" } as never, null as never],
      WINNER,
    );
    expect(out).toEqual([RUNNER_UP]);
  });
});

describe("what it says", () => {
  it("says plainly that the job is gone, and names it", () => {
    const { title, message } = positionFilledMessage("Coffee Roastery Logo");
    expect(title).toMatch(/went to someone else/i);
    expect(message).toContain("Coffee Roastery Logo");
  });

  /* "The position has been filled" leaves someone wondering whether to keep
     waiting. Saying the application is closed is the part they can act on. */
  it("tells them they are free to take other work", () => {
    expect(positionFilledMessage("x").message).toMatch(/free to take on other work/i);
  });
});
