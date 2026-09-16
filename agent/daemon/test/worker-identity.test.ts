import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ONE IDENTITY, ONE WALLET — AND SAYING WHICH ONE YOU ARE IN.
 *
 * A freelancer signed in, saw a different address from the one that had been
 * hired for a job, and reasonably concluded the app had issued them a new
 * wallet and stranded their work. It had not: they had two Google accounts,
 * both with the handle "cdev", and the dashboard showed a handle and a
 * truncated hex address and nothing that distinguished the two.
 *
 * Two things follow. The account a person lands in must be decided by their
 * verified identity and nothing else, including its spelling. And the screen
 * has to say which identity that was, or a wrong-account sign-in is
 * indistinguishable from losing your money.
 */

const insertWorker = vi.fn((w: any) => ({ ...w, createdAt: Date.now() }));
const getWorkerByChannelRef = vi.fn();
const provisionWorkerWallet = vi.fn();
const dripGas = vi.fn();

vi.mock("../src/store.js", () => ({
  insertWorker,
  getWorkerByChannelRef: (c: string, r: string) => getWorkerByChannelRef(c, r),
  getWorker: vi.fn(),
  listTasks: () => [],
  listDecisions: () => [],
  getPollerText: () => null,
  setPollerText: () => {},
}));
vi.mock("../src/workers/wallets.js", () => ({
  provisionWorkerWallet: () => provisionWorkerWallet(),
  dripGas: (a: string) => dripGas(a),
  workerBalance: vi.fn(),
  withdrawTo: vi.fn(),
}));
vi.mock("../src/agent/handover.js", () => ({ criteriaFor: () => ({ criteria: [], source: "none" }) }));
vi.mock("../src/web3/atelier.js", () => ({}));
vi.mock("../src/circle/circleSigner.js", () => ({ createSignerFor: vi.fn() }));
vi.mock("../src/config.js", () => ({ config: { applicationWindowMinutes: 3 } }));
vi.mock("../src/graph/client.js", () => ({ graphQuery: vi.fn() }));

const { join } = await import("../src/workers/service.js");

beforeEach(() => {
  vi.clearAllMocks();
  getWorkerByChannelRef.mockReturnValue(null);
  provisionWorkerWallet.mockResolvedValue({ walletId: "w-new", address: "0xNEW" });
});

describe("signing in again with the same identity", () => {
  it("returns the existing wallet rather than minting another", async () => {
    const existing = { id: "w1", handle: "cdev", walletAddress: "0x8289", channelRef: "me@gmail.com" };
    getWorkerByChannelRef.mockReturnValue(existing);

    const out = await join({ handle: "cdev", channel: "web", channelRef: "me@gmail.com" });

    expect(out).toBe(existing);
    expect(provisionWorkerWallet).not.toHaveBeenCalled();
  });

  it("is not fooled by a different handle on the same account", async () => {
    // The handle is a display name, not a key. Typing a new one on the way back
    // in must not fork the account that holds the money.
    const existing = { id: "w1", handle: "cdev", walletAddress: "0x8289", channelRef: "me@gmail.com" };
    getWorkerByChannelRef.mockReturnValue(existing);

    const out = await join({ handle: "somethingElse", channel: "web", channelRef: "me@gmail.com" });

    expect(out.walletAddress).toBe("0x8289");
    expect(provisionWorkerWallet).not.toHaveBeenCalled();
  });

  it("is not fooled by capitalisation", async () => {
    // An email is not case-sensitive in the part that matters, and this column
    // was. "Me@Gmail.com" and "me@gmail.com" would have been two wallets, and
    // the one holding the balance is the one its owner could no longer reach.
    await join({ handle: "cdev", channel: "web", channelRef: "  Me@Gmail.COM " });

    expect(getWorkerByChannelRef).toHaveBeenCalledWith("web", "me@gmail.com");
  });

  it("stores the normalised form, so the next lookup matches too", async () => {
    await join({ handle: "cdev", channel: "web", channelRef: "Me@Gmail.COM" });

    expect(insertWorker.mock.calls[0][0].channelRef).toBe("me@gmail.com");
  });
});

describe("a genuinely new person", () => {
  it("gets a wallet, and gas to use it with", async () => {
    const out = await join({ handle: "newbie", channel: "web", channelRef: "new@gmail.com" });

    expect(out.walletAddress).toBe("0xNEW");
    expect(dripGas).toHaveBeenCalledWith("0xNEW");
  });

  it("keeps their own address untouched when they bring one", async () => {
    const out = await join({
      handle: "byok",
      channel: "web",
      channelRef: "own@gmail.com",
      ownAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(out.mode).toBe("own");
    expect(provisionWorkerWallet).not.toHaveBeenCalled();
  });
});
