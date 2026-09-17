import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GAS IS ETH, EARNINGS ARE USDC, AND THEY ARE NOT THE SAME NUMBER.
 *
 * On the chain this was built for they were: the native currency WAS USDC, so
 * one balance answered both "have they been paid?" and "can they sign?". The
 * port to Arbitrum split those apart and nothing here noticed. dripGas kept
 * transferring USDC, and ensureGas kept measuring USDC against its floor — so a
 * managed worker holding 0.05 USDC and zero ETH was reported funded and then
 * failed every transaction with a raw "insufficient funds for gas", which the
 * API's sanitiser renders as OUR treasury being empty.
 *
 * There was no test on this path at all, which is why the port passed 210 of
 * them. These are that test.
 */

const getWorker = vi.fn();
const workerBalance = vi.fn();
const workerGasBalance = vi.fn();
const dripGas = vi.fn();
const hasApplied = vi.fn();
const applyToJob = vi.fn();
const createSignerFor = vi.fn();

const ME = "0x00000000000000000000000000000000000000ab";

vi.mock("../src/store.js", () => ({
  getWorker: (id: string) => getWorker(id),
  insertWorker: vi.fn(),
  getWorkerByChannelRef: vi.fn(),
  listTasks: () => [],
  listDecisions: () => [],
  getPollerText: () => null,
  setPollerText: () => {},
  insertTask: vi.fn(),
  updateTask: vi.fn(),
  getTask: vi.fn(),
  insertDecision: vi.fn(),
}));

vi.mock("../src/workers/wallets.js", () => ({
  workerBalance: (a: string) => workerBalance(a),
  workerGasBalance: (a: string) => workerGasBalance(a),
  dripGas: (a: string) => dripGas(a),
  provisionWorkerWallet: vi.fn(),
  withdrawTo: vi.fn(),
}));

vi.mock("../src/web3/journeyman.js", () => ({
  hasApplied: (...a: unknown[]) => hasApplied(...a),
  applyToJob: (...a: unknown[]) => applyToJob(...a),
  getEscrow: vi.fn(),
  getMilestones: vi.fn(),
  jobManagerOf: vi.fn(),
  openEscrows: vi.fn(),
}));

vi.mock("../src/circle/circleSigner.js", () => ({
  createSignerFor: (a: string) => createSignerFor(a),
  signMessageAsWallet: vi.fn(),
  createCircleSigner: vi.fn(),
}));
vi.mock("../src/agent/handover.js", () => ({ criteriaFor: () => ({ criteria: [], source: "none" }) }));
vi.mock("../src/config.js", () => ({ config: { applicationWindowMinutes: 3, apiUrl: "", apiSecret: "" } }));
vi.mock("../src/graph/client.js", () => ({ graphQuery: vi.fn() }));

const { apply } = await import("../src/workers/service.js");

beforeEach(() => {
  vi.clearAllMocks();
  getWorker.mockReturnValue({ id: "w1", walletAddress: ME, mode: "managed" });
  createSignerFor.mockReturnValue({ address: ME });
  hasApplied.mockResolvedValue(false);
  applyToJob.mockResolvedValue("0xdead");
  /* Paid, and unable to move any of it. The exact state the old check called healthy. */
  workerBalance.mockResolvedValue("42.00");
  workerGasBalance.mockResolvedValue("0");
  dripGas.mockResolvedValue("0xdrip");
});

describe("making sure a worker can pay for their own transaction", () => {
  it("tops up a worker who holds USDC but no ETH", async () => {
    workerGasBalance.mockResolvedValueOnce("0").mockResolvedValue("0.0005");

    await apply("w1", "1", "I can do this", undefined);

    expect(dripGas).toHaveBeenCalledWith(ME);
    expect(applyToJob).toHaveBeenCalled();
  });

  it("does not spend a drip on somebody who already has gas", async () => {
    workerGasBalance.mockResolvedValue("0.01");

    await apply("w1", "1", "I can do this", undefined);

    expect(dripGas).not.toHaveBeenCalled();
  });

  it("never reads the USDC balance to decide whether they can sign", async () => {
    // The bug in one line: earnings answered a question about fees.
    workerGasBalance.mockResolvedValueOnce("0").mockResolvedValue("0.0005");
    await apply("w1", "1", "I can do this", undefined);
    expect(workerBalance).not.toHaveBeenCalled();
  });

  it("says so in plain words when the drip has not landed yet", async () => {
    // Still zero after the top-up: the funding is in flight, not missing.
    workerGasBalance.mockResolvedValue("0");

    await expect(apply("w1", "1", "I can do this", undefined)).rejects.toThrow(/still being funded/i);
    expect(applyToJob).not.toHaveBeenCalled();
  });

  it("does not ask a worker using their own keys to take our gas", async () => {
    getWorker.mockReturnValue({ id: "w1", walletAddress: ME, mode: "own" });

    await expect(apply("w1", "1", "I can do this", undefined)).rejects.toThrow(/can't sign for you/i);
    expect(dripGas).not.toHaveBeenCalled();
  });
});
