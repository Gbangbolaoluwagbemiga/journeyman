import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A NOTIFICATION THAT IS NOT DELIVERED IS NOT A NOTIFICATION.
 *
 * The routing here was right the whole time — a submission goes to the client,
 * a rejection to the freelancer — and nobody received anything for a day. Two
 * config faults, one after the other:
 *
 *   API_URL unset, so post() returned false before sending anything
 *   API_SECRET unset, so every POST that did go out came back 401
 *
 * Both failed silently. `return false` and `catch { return false }` meant the
 * only symptom of either was a quiet bell, and the search went into the routing
 * logic twice because that is the only part that was visible.
 *
 * So: failures say so. The point of these tests is the saying.
 */

const getEscrow = vi.fn();
vi.mock("../src/web3/atelier.js", () => ({ getEscrow: (id: bigint) => getEscrow(id) }));
vi.mock("../src/store.js", () => ({ listTasks: () => [], hiredFor: () => null }));

let apiUrl = "https://api.test";
let apiSecret = "s3cret";
vi.mock("../src/config.js", () => ({
  config: {
    get apiUrl() { return apiUrl; },
    get apiSecret() { return apiSecret; },
    publicAppUrl: "https://app.test",
  },
}));

const { notifyWeb } = await import("../src/notify/web.js");

const CLIENT = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  apiUrl = "https://api.test";
  apiSecret = "s3cret";
  getEscrow.mockResolvedValue({ depositor: CLIENT, beneficiary: CLIENT });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const submission = { type: "work_submitted", message: "m", escrowId: "7", timestamp: 1 } as never;

describe("when the post is rejected", () => {
  it("says so, with the status and the body", async () => {
    // The 401 that hid behind a silent `return res.ok` for a day.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, text: async () => '{"error":"Unauthorized"}',
    })));

    expect(await notifyWeb(submission)).toBe(0);

    const said = (console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(said).toMatch(/401/);
    expect(said).toMatch(/Unauthorized/);
  });

  it("says so when the request cannot be made at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    expect(await notifyWeb(submission)).toBe(0);
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ")).toMatch(/ECONNREFUSED/);
  });

  it("never throws — a hire must not fail because a courtesy did", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    await expect(notifyWeb(submission)).resolves.toBe(0);
  });
});

describe("when it works", () => {
  it("authenticates, and reports what it delivered", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await notifyWeb(submission)).toBe(1);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer s3cret");
  });
});
