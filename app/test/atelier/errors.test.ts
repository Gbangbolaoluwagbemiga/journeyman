import { describe, it, expect } from "vitest";
import { humanizeError } from "@/lib/atelier/errors";

/**
 * The case that motivated this: a real viem rejection, verbatim from a toast.
 * Every word true, none of it useful, and the one sentence that mattered was
 * buried in front of a wall the eye slides off.
 */
const VIEM_REJECTION = `User rejected the request. Request Arguments: chain: Arc EVM Testnet (id: 5042002) from: 0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41 to: 0x370e1517Fe56fF3ebCFc3D7ed08563fB88910C11 data: 0x0735ab8600000000000000000000000000000000000000000000000000000000 Contract Call: address: 0x370e1517Fe56fF3ebCFc3D7ed08563fB88910C11 Version: viem@2.49.0`;

describe("wallet failures", () => {
  it("says you cancelled it, and nothing else", () => {
    const out = humanizeError(new Error(VIEM_REJECTION));
    expect(out).toBe("You cancelled the transaction in your wallet.");
    expect(out).not.toMatch(/0x|viem|Request Arguments/);
  });

  it("recognises the other spellings wallets use", () => {
    for (const m of [
      "User denied transaction signature",
      "ACTION_REJECTED",
      "MetaMask Tx Signature: User rejected the request.",
    ]) {
      expect(humanizeError(new Error(m))).toMatch(/cancelled the transaction/i);
    }
  });

  it("tells someone on the wrong network what to do about it", () => {
    expect(
      humanizeError(new Error("ChainMismatchError: chain does not match the target chain")),
    ).toMatch(/switch it to arc/i);
  });

  it("separates an empty balance from a rejection", () => {
    expect(humanizeError(new Error("insufficient funds for gas * price + value")))
      .toMatch(/not enough balance/i);
  });
});

describe("contract custom errors", () => {
  /**
   * "Unauthorized()" in a toast tells a client nothing. The point of this map is
   * that the message explains WHY the button did not work.
   */
  it("explains Unauthorized in terms of who may act", () => {
    expect(
      humanizeError(new Error("execution reverted with the following custom error: Unauthorized()")),
    ).toMatch(/only the client who funded/i);
  });

  it("explains the one-way key guards in product terms", () => {
    expect(humanizeError(new Error("ManagerCannotBeBeneficiary()"))).toMatch(
      /stops it paying itself/i,
    );
    expect(humanizeError(new Error("ManagerCannotSelfHire()"))).toMatch(
      /cannot hire itself/i,
    );
  });

  it("does not match a custom error name that merely appears as a word", () => {
    // Needs the call parens — otherwise prose mentioning a name would hijack it.
    expect(humanizeError(new Error("the request was Unauthorized by the relay"))).not.toMatch(
      /only the client who funded/i,
    );
  });
});

describe("anything else", () => {
  it("keeps a revert reason the contract author wrote for a human", () => {
    expect(
      humanizeError(new Error(`reverted with reason string 'Deadline already passed'`)),
    ).toBe("Deadline already passed");
  });

  /**
   * An unrecognised error still gets its first clause rather than the dump. A
   * truncated real message beats "Something went wrong", and the console keeps
   * the whole thing.
   */
  it("cuts an unknown error at the point it stops being about the user", () => {
    const out = humanizeError(
      new Error("Something odd happened. Request Arguments: chain: Arc data: 0xdeadbeef"),
    );
    expect(out).toBe("Something odd happened.");
  });

  it("never returns an empty string", () => {
    for (const input of [null, undefined, "", {}, new Error("")]) {
      expect(humanizeError(input).length).toBeGreaterThan(0);
    }
  });

  it("never puts a wall of text in front of someone", () => {
    const huge = new Error("x".repeat(5000));
    expect(humanizeError(huge).length).toBeLessThanOrEqual(200);
  });

  it("reads through a wrapped cause", () => {
    const inner = new Error("User rejected the request.");
    const outer = new Error("Transaction failed");
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(humanizeError(outer)).toMatch(/cancelled the transaction/i);
  });
});
