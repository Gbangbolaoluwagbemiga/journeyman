import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * WHO IS USING THE APP RIGHT NOW.
 *
 * Atelier has two ways to be somebody, and most of it was written when only
 * one existed. Surfaces reached for `wallet.address`, so a managed worker —
 * who signs in with Google and never connects a wallet — read as nobody.
 *
 * Messages was where that stopped being cosmetic: a client sent a direct
 * message to a freelancer on a managed wallet, and that freelancer's inbox
 * asked for the conversations of the empty string.
 */

let connected: string | null = null;
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: connected, isConnected: !!connected } }),
}));

let stored: string | null = null;
vi.mock("@/lib/atelier/worker", () => ({
  currentWorkerAddress: () => stored,
  WORKER_IDENTITY_EVENT: "atelier:worker-identity",
}));

const { useMyAddress, sameAddress } = await import("@/hooks/use-my-address");

const WALLET = "0x3Be7000000000000000000000000000000008E41";
const MANAGED = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";

beforeEach(() => {
  connected = null;
  stored = null;
});

describe("who I am", () => {
  it("is the managed wallet when that is the only account", () => {
    stored = MANAGED;
    expect(renderHook(() => useMyAddress()).result.current).toBe(MANAGED);
  });

  it("is the connected wallet when there is one", () => {
    connected = WALLET;
    stored = MANAGED;
    expect(renderHook(() => useMyAddress()).result.current).toBe(WALLET);
  });

  it("is nobody before either door is used", () => {
    expect(renderHook(() => useMyAddress()).result.current).toBeNull();
  });

  it("notices a sign-in that happens after the hook mounted", () => {
    const { result, rerender } = renderHook(() => useMyAddress());
    expect(result.current).toBeNull();

    stored = MANAGED;
    window.dispatchEvent(new Event("atelier:worker-identity"));
    rerender();

    expect(result.current).toBe(MANAGED);
  });
});

describe("comparing two addresses", () => {
  it("treats the checksummed and lowercase spellings as one person", () => {
    // The bug: the chain hands back mixed case, the daemon issues lowercase,
    // and `===` said those were two different people.
    expect(sameAddress(MANAGED, MANAGED.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("is still false for two different people", () => {
    expect(sameAddress(WALLET, MANAGED)).toBe(false);
  });

  it("is false rather than throwing when somebody is not signed in", () => {
    expect(sameAddress(null, MANAGED)).toBe(false);
    expect(sameAddress(MANAGED, undefined)).toBe(false);
  });
});
