import { describe, expect, it } from "vitest";
import { formatTokenAmount, formatUsdc, rawToNumber, USDC_ADDRESS } from "@/lib/utils";

/**
 * WHAT A RAW NUMBER MEANS DEPENDS ON THE TOKEN, AND THE TOKEN CHANGED.
 *
 * address(0) used to mean USDC, because on the chain this was built for the
 * native currency WAS USDC at six decimals. On Arbitrum address(0) is ETH at
 * eighteen, and Journeyman.createEscrow still accepts address(0) escrows
 * without whitelisting them — so a native escrow here really does hold ether.
 *
 * The old mapping did not throw on any of this. It printed a number, with a
 * currency symbol next to it, off by twelve orders of magnitude.
 */

const ZERO = "0x0000000000000000000000000000000000000000";

describe("what a raw amount is worth", () => {
  it("reads USDC at six decimals", () => {
    expect(formatTokenAmount(5_000_000n, USDC_ADDRESS)).toBe("5 USDC");
  });

  it("reads the chain's own currency as ETH at eighteen", () => {
    // One ether. Under the old six-decimal mapping this rendered as
    // "1,000,000,000,000 USDC" — a trillion dollars, in an escrow card.
    expect(formatTokenAmount(10n ** 18n, ZERO)).toBe("1 ETH");
  });

  it("does not quietly call an unknown token dollars", () => {
    expect(formatTokenAmount(10n ** 18n, "0x00000000000000000000000000000000000000ff")).toBe("1 tokens");
  });

  it("formatUsdc names the settlement currency instead of assuming it", () => {
    // The point of the helper: callers that mean dollars say dollars, rather
    // than passing address(0) and relying on what the chain happens to be.
    expect(formatUsdc(2_500_000n)).toBe("2.5 USDC");
    expect(formatUsdc(2_500_000n)).toBe(formatTokenAmount(2_500_000n, USDC_ADDRESS));
  });

  it("rounds USDC to cents and leaves other tokens more room", () => {
    expect(formatUsdc(1_234_567n)).toBe("1.23 USDC");
    expect(formatTokenAmount(10n ** 18n + 10n ** 12n, ZERO)).toBe("1.000001 ETH");
  });

  it("converts to a plain number on the same rules", () => {
    expect(rawToNumber(5_000_000n, USDC_ADDRESS)).toBe(5);
    expect(rawToNumber(10n ** 18n, ZERO)).toBe(1);
  });

  it("says zero in the right currency rather than guessing", () => {
    expect(formatTokenAmount(0n, USDC_ADDRESS)).toBe("0 USDC");
    expect(formatTokenAmount(null, ZERO)).toBe("0 ETH");
  });
});
