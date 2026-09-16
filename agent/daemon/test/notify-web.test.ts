import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../src/agent/AgentClient.js";

/**
 * WHO GETS TOLD WHEN THE AGENT ACTS.
 *
 * The bug this covers is not that a message looked wrong — it is that for web
 * users there was no message. Notifications are written from the acting party's
 * browser, and when the agent hires or pays there is no browser, so Autopilot
 * was the one mode where a client had to sit and watch the job.
 *
 * Two properties matter more than any wording:
 *
 *   the right person is told, and nobody else is
 *   the agent's loop survives the notification failing
 *
 * The second is why every path here resolves rather than throws. A hire that
 * already happened on-chain must not be undone by an unreachable API.
 */

const getEscrow = vi.fn();
const getEscrowApplications = vi.fn();
vi.mock("../src/web3/atelier.js", () => ({ getEscrow, getEscrowApplications }));
vi.mock("../src/config.js", () => ({
  config: {
    apiUrl: "https://api.test",
    apiSecret: "s3cret",
    publicAppUrl: "https://app.test",
  },
}));

const { notifyWeb, recipientsFor } = await import("../src/notify/web.js");

const CLIENT = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

function event(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "applicant_accepted",
    message: "Hired 0x2222…",
    escrowId: "5",
    timestamp: Date.now(),
    decision: {
      id: "d1",
      taskId: "5",
      type: "applicant_accepted",
      reasoning: "Highest comparative score.",
      target: WORKER,
      timestamp: Date.now(),
    },
    ...over,
  } as AgentEvent;
}

beforeEach(() => {
  getEscrow.mockReset();
  getEscrow.mockResolvedValue({ depositor: CLIENT, beneficiary: WORKER });
  getEscrowApplications.mockReset();
  getEscrowApplications.mockResolvedValue([WORKER]);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 201 })));
});

describe("a hire", () => {
  it("tells the freelancer they got it", async () => {
    const to = (await recipientsFor(event())).find((n) => n.to === WORKER);
    expect(to?.title).toMatch(/you got the job/i);
  });

  /* The person who paid had to keep a tab open to learn about their own money. */
  it("tells the client too", async () => {
    const to = (await recipientsFor(event())).find((n) => n.to === CLIENT);
    expect(to?.title).toMatch(/hired/i);
  });

  it("tells nobody else", async () => {
    const list = await recipientsFor(event());
    expect(new Set(list.map((n) => n.to))).toEqual(new Set([WORKER, CLIENT]));
  });
});

/**
 * They applied, waited, and were told nothing — the job simply went quiet on
 * them forever. An answer you did not want is still better than silence, and
 * someone who knows they were not picked can go apply for the next one.
 */
describe("the people who did not get it", () => {
  const LOSER_A = "0x3333333333333333333333333333333333333333";
  const LOSER_B = "0x4444444444444444444444444444444444444444";

  it("tells every other applicant the job is gone", async () => {
    getEscrowApplications.mockResolvedValue([WORKER, LOSER_A, LOSER_B]);
    const list = await recipientsFor(event());
    const told = list.filter((n) => /went to someone else/i.test(n.title)).map((n) => n.to);
    expect(new Set(told)).toEqual(new Set([LOSER_A, LOSER_B]));
  });

  /* A rejection arriving right behind the congratulations is the single worst
     thing this could do. */
  it("never sends the winner a rejection", async () => {
    getEscrowApplications.mockResolvedValue([WORKER, LOSER_A]);
    const list = await recipientsFor(event());
    const toWinner = list.filter((n) => n.to === WORKER);
    expect(toWinner).toHaveLength(1);
    expect(toWinner[0].title).toMatch(/you got the job/i);
  });

  it("tells someone once even if they applied twice", async () => {
    getEscrowApplications.mockResolvedValue([WORKER, LOSER_A, LOSER_A.toUpperCase()]);
    const list = await recipientsFor(event());
    expect(list.filter((n) => n.to.toLowerCase() === LOSER_A.toLowerCase())).toHaveLength(1);
  });

  /* A client can apply to their own board from a second wallet. */
  it("does not send the client a rejection for their own job", async () => {
    getEscrowApplications.mockResolvedValue([WORKER, CLIENT]);
    const list = await recipientsFor(event());
    expect(list.filter((n) => n.to === CLIENT)).toHaveLength(1);
    expect(list.find((n) => n.to === CLIENT)?.title).toMatch(/hired/i);
  });

  it("still tells the winner and client when the applicant list cannot be read", async () => {
    getEscrowApplications.mockRejectedValue(new Error("rpc down"));
    const list = await recipientsFor(event());
    expect(new Set(list.map((n) => n.to))).toEqual(new Set([WORKER, CLIENT]));
  });

  /* Nobody hired is still an outcome — and this one they can act on, because
     the job is still open. */
  it("tells applicants when nobody cleared the bar, and says it is still open", async () => {
    getEscrowApplications.mockResolvedValue([LOSER_A]);
    const list = await recipientsFor(event({ type: "no_suitable_applicant", decision: undefined }));
    const toLoser = list.find((n) => n.to === LOSER_A);
    expect(toLoser?.message).toMatch(/still open/i);
  });
});

describe("a payment", () => {
  it("tells the freelancer, and names the amount", async () => {
    const list = await recipientsFor(
      event({ type: "payment_released", amountUsdc: "4", decision: undefined }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].to).toBe(WORKER);
    expect(list[0].message).toContain("$4");
  });

  /* An amount we do not have must not become "$undefined". */
  it("still says they were paid when the amount is unknown", async () => {
    const list = await recipientsFor(
      event({ type: "payment_released", amountUsdc: undefined, decision: undefined }),
    );
    expect(list[0].message).toMatch(/released to you/i);
    expect(list[0].message).not.toMatch(/undefined|NaN/);
  });

  it("says nothing when the escrow has no freelancer to pay", async () => {
    getEscrow.mockResolvedValue({ depositor: CLIENT, beneficiary: ZERO });
    const list = await recipientsFor(event({ type: "payment_released", decision: undefined }));
    expect(list).toEqual([]);
  });
});

describe("an escalation", () => {
  it("reaches both sides, because both have to stop waiting", async () => {
    const list = await recipientsFor(event({ type: "escalated_to_human", decision: undefined }));
    expect(new Set(list.map((n) => n.to))).toEqual(new Set([WORKER, CLIENT]));
    expect(list.every((n) => n.type === "dispute")).toBe(true);
  });
});

/**
 * BEING SCORED IS AN OUTCOME, NOT PROGRESS.
 *
 * This event used to be deliberately silent, filed with "scoring applicants…"
 * under the rule that progress is not news. That rule is right and it does not
 * cover this one: the score is a judgement ABOUT the person, it is the thing
 * that decides whether they get the work, and it was written to the decision
 * log in full while the applicant was told nothing at all.
 */
describe("telling an applicant what they scored", () => {
  it("sends the score and the reasoning, to that applicant only", async () => {
    const list = await recipientsFor(
      event({
        type: "application_scored",
        decision: {
          id: "d1",
          taskId: "5",
          type: "application_scored",
          target: WORKER,
          score: 25,
          reasoning: "No evidence of vector illustration work in the cover letter.",
          timestamp: 1,
        },
      }),
    );

    expect(list).toHaveLength(1);
    expect(list[0].to).toBe(WORKER);
    expect(list[0].title).toContain("25/100");
    // The reasoning, not just the number — it is the only part they can act on.
    expect(list[0].message).toContain("vector illustration");
  });

  it("never tells one applicant about another's score", async () => {
    const list = await recipientsFor(
      event({
        type: "application_scored",
        decision: {
          id: "d1", taskId: "5", type: "application_scored",
          target: WORKER, score: 90, reasoning: "Strong.", timestamp: 1,
        },
      }),
    );
    // A comparative ranking is the client's to see in full. Broadcasting it
    // would publish a judgement about a named person to their competitors.
    expect(list.map((n) => n.to)).toEqual([WORKER]);
  });

  it("still says something useful when the score is missing", async () => {
    const list = await recipientsFor(
      event({
        type: "application_scored",
        decision: {
          id: "d1", taskId: "5", type: "application_scored",
          target: WORKER, reasoning: "", timestamp: 1,
        } as never,
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].title).toMatch(/has been read/i);
  });

  it("has nobody to tell when the decision names no applicant", async () => {
    expect(
      await recipientsFor(event({ type: "application_scored", decision: undefined })),
    ).toEqual([]);
  });
});

/**
 * A DELIVERY IS NOT PROGRESS — IT IS SOMETHING THE CLIENT MUST ACT ON.
 *
 * This sat in the "deliberately silent" list, which was wrong in the one
 * direction that matters. A submission waits until somebody approves or rejects
 * it, the client is the only person who can, and nothing told them it had
 * arrived. They reloaded the page on a hunch and found work already waiting.
 */
describe("work arriving", () => {
  it("tells the client, and says their money is still theirs until they approve", async () => {
    const list = await recipientsFor(event({ type: "work_submitted", decision: undefined }));

    expect(list).toHaveLength(1);
    expect(list[0].to).toBe(CLIENT);
    expect(list[0].message).toMatch(/stays in escrow until you approve/i);
  });
});

/**
 * Progress is not news. Pushing "fetching applications…" to the bell teaches
 * people to ignore it, and the bell is how they find out they were paid.
 */
describe("what is deliberately not a notification", () => {
  it.each(["applications_fetched", "brief_generated"])(
    "stays quiet on %s",
    async (type) => {
      expect(await recipientsFor(event({ type: type as AgentEvent["type"] }))).toEqual([]);
    },
  );

  it("stays quiet on an event with no escrow attached", async () => {
    expect(await recipientsFor(event({ escrowId: undefined }))).toEqual([]);
  });
});

describe("what it sends", () => {
  it("authenticates, and points the link at the job", async () => {
    await notifyWeb(event());
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.test/v1/notifications");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init.body).action_url).toBe("https://app.test/jobs/5");
  });

  it("marks the source, so a client can see the agent did it", async () => {
    await notifyWeb(event());
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).data.source).toBe("autopilot");
  });
});

/**
 * The agent's loop pays people. It must survive anything this module can hit.
 */
describe("when it cannot deliver", () => {
  it("does not throw when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(notifyWeb(event())).resolves.toBe(0);
  });

  it("does not throw when the API rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(notifyWeb(event())).resolves.toBe(0);
  });

  it("does not throw when the chain read fails", async () => {
    getEscrow.mockRejectedValue(new Error("rpc down"));
    await expect(notifyWeb(event({ type: "payment_released", decision: undefined }))).resolves.toBe(0);
  });

  /* Still delivers to the freelancer even if the client cannot be resolved. */
  it("delivers what it can when only part of the lookup fails", async () => {
    getEscrow.mockResolvedValue({ depositor: ZERO, beneficiary: WORKER });
    expect(await notifyWeb(event())).toBe(1);
  });
});
