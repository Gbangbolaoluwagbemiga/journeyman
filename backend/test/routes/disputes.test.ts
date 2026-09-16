import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { chainableResult, makeSupabaseMock } from "../helpers/supabase-mock.js";

/**
 * THE ARBITER'S REASONING, WHERE BOTH SIDES CAN READ IT.
 *
 * A human settles a dispute and writes why. That sentence was saved to
 * localStorage in the browser of whoever resolved it, and the contract's
 * DisputeResolved event carries the amounts but not the words — so it existed
 * in one place, on one machine, belonging to one party. The client could read
 * it; the freelancer whose payment it decided could not, from anywhere.
 *
 * What these tests are really protecting is the other half: a public endpoint
 * that records WHY somebody was or was not paid must not let a stranger author
 * it. A signature alone is not enough — anybody can sign anything. The signer
 * has to be the arbiter named in the on-chain event for that exact milestone.
 */

let supabaseInstance: ReturnType<typeof makeSupabaseMock> | null = null;
vi.mock("../../src/lib/supabase.js", () => ({ getSupabase: () => supabaseInstance }));

const verifyMessage = vi.fn();
const getLogs = vi.fn();
/* The lookup walks backwards from the head in windows — "earliest" is refused
   outright by the RPC, so it has to know where the head is. */
const getBlockNumber = vi.fn(async () => 1_000_000n);
vi.mock("viem", async (orig) => ({
  ...(await orig<typeof import("viem")>()),
  createPublicClient: () => ({ getLogs, getBlockNumber }),
  verifyMessage: (a: unknown) => verifyMessage(a),
}));

process.env.CONTRACT_ADDRESS = "0x00000000000000000000000000000000000A7E11";

const { disputesRouter, buildResolutionAuthMessage } = await import("../../src/routes/disputes.js");

const app = express();
app.use(express.json());
app.use("/v1/disputes", disputesRouter);

const ARBITER = "0x1111111111111111111111111111111111111111";

function note(over: Record<string, unknown> = {}) {
  const timestamp = String(Date.now());
  return {
    escrow_id: "7",
    milestone_index: "1",
    arbiter_address: ARBITER,
    reason: "The deliverable never arrived.",
    signature: "0xsig",
    timestamp,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  supabaseInstance = makeSupabaseMock({ from: () => chainableResult({ data: null, error: null }) });
  verifyMessage.mockResolvedValue(true);
  getLogs.mockResolvedValue([{ blockNumber: 1n }]); // they did resolve it
  getBlockNumber.mockResolvedValue(1_000_000n);
});

describe("recording why a dispute was settled", () => {
  it("saves it when the signer is the arbiter who resolved it", async () => {
    const res = await request(app).post("/v1/disputes/resolution").send(note());
    expect(res.status).toBe(201);
  });

  it("refuses a signature from somebody who did not resolve it", async () => {
    // The signature verifies — it just is not the arbiter's. Without this check
    // the reasoning behind another person's payment would be anybody's to write.
    getLogs.mockResolvedValue([]);

    const res = await request(app).post("/v1/disputes/resolution").send(note());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the arbiter/i);
  });

  it("refuses a bad signature", async () => {
    verifyMessage.mockResolvedValue(false);
    const res = await request(app).post("/v1/disputes/resolution").send(note());
    expect(res.status).toBe(401);
  });

  it("refuses a stale authorization", async () => {
    const res = await request(app)
      .post("/v1/disputes/resolution")
      .send(note({ timestamp: String(Date.now() - 60 * 60 * 1000) }));
    expect(res.status).toBe(401);
    // And never reaches the chain to ask.
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("refuses an empty reason — it is the whole point of writing one", async () => {
    const res = await request(app).post("/v1/disputes/resolution").send(note({ reason: "   " }));
    expect(res.status).toBe(400);
  });

  it("signs over the escrow and the milestone, so one note cannot be replayed onto another", () => {
    const a = buildResolutionAuthMessage("7", "1", ARBITER, "123");
    expect(a).not.toBe(buildResolutionAuthMessage("8", "1", ARBITER, "123"));
    expect(a).not.toBe(buildResolutionAuthMessage("7", "0", ARBITER, "123"));
    expect(a).toContain(ARBITER.toLowerCase());
  });
});

describe("reading them back", () => {
  it("returns the notes for an escrow", async () => {
    supabaseInstance = makeSupabaseMock({
      from: () =>
        chainableResult({
          data: [{ milestone_index: 1, arbiter_address: ARBITER, reason: "Nothing delivered.", resolved_at: "x" }],
          error: null,
        }),
    });

    const res = await request(app).get("/v1/disputes/resolution?escrow_id=7");
    expect(res.status).toBe(200);
    expect(res.body.resolutions[0].reason).toBe("Nothing delivered.");
  });

  it("answers empty rather than failing before the table exists", async () => {
    // A deployment that has not run the migration is not a broken request, and
    // a 500 here would take a job card down over an explanation nobody wrote.
    supabaseInstance = makeSupabaseMock({
      from: () =>
        chainableResult({
          data: null,
          error: { message: 'relation "public.dispute_resolutions" does not exist' },
        }),
    });

    const res = await request(app).get("/v1/disputes/resolution?escrow_id=7");
    expect(res.status).toBe(200);
    expect(res.body.resolutions).toEqual([]);
  });
});


describe("how it looks for the resolution", () => {
  it("never asks the RPC for the whole chain", async () => {
    // `fromBlock: "earliest"` comes back as a failure rather than a truncated
    // result, so this returned false for every caller — including the real
    // arbiter. The write path could not have worked at all.
    await request(app).post("/v1/disputes/resolution").send(note());

    for (const [args] of getLogs.mock.calls) {
      expect(args.fromBlock).not.toBe("earliest");
      expect(typeof args.fromBlock).toBe("bigint");
    }
  });

  it("stops as soon as it finds it, rather than walking the rest", async () => {
    await request(app).post("/v1/disputes/resolution").send(note());
    // A note is written seconds after the resolution it describes, so the match
    // is in the first window it looks at.
    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});
