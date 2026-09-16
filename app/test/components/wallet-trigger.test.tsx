import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * THE HEADER CONTROL, AND WHAT IT STOPPED SAYING.
 *
 * The trigger carried a network icon, the balance, the word USDC, a separator,
 * an identicon and a truncated address — roughly 310px of a header that also
 * holds a theme toggle, a message icon and a bell. Enough to push the nav off
 * centre and make the bar look mis-assembled.
 *
 * What stayed had to earn it. The identicon IS the address — derived from it,
 * so it changes the moment you switch accounts, and two accounts are quicker to
 * tell apart by colour than by reading 0x3Be7…8E41 against 0x8289…c423. The
 * balance is the number people glance up to check.
 *
 * The address itself is one click away in a modal that shows it in full with a
 * copy button, so it lives in the tooltip and the accessible name instead of
 * the bar. That last part is the bit worth testing: "compact" must not mean
 * "unreachable".
 */

const ADDRESS = "0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41";

let wallet = { isConnected: true, address: ADDRESS, balance: "108.28" };
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet, connectWallet: vi.fn() }),
}));
vi.mock("@reown/appkit/react", () => ({ useAppKit: () => ({ open: vi.fn() }) }));
vi.mock("@/hooks/use-managed-worker", () => ({
  useManagedWorker: () => ({ worker: null, refresh: vi.fn(), refreshing: false }),
}));

const { WalletButton } = await import("@/components/wallet-button");

beforeEach(() => {
  wallet = { isConnected: true, address: ADDRESS, balance: "108.28" };
});

describe("the connected wallet control", () => {
  it("shows the balance as money, not as a token amount", () => {
    render(<WalletButton />);
    // "$108.28" rather than "108.28 USDC" — Arc's native currency IS USDC, and
    // the symbol says it in one character instead of five.
    expect(screen.getByText("$108.28")).toBeInTheDocument();
  });

  it("does not put the address in the bar", () => {
    render(<WalletButton />);
    expect(screen.queryByText(/0x3Be7…8E41/)).not.toBeInTheDocument();
  });

  it("still hands the address to anyone who needs it", () => {
    // Compact must not mean unreachable: a tooltip for a mouse, an accessible
    // name for a screen reader, and the full thing in the account modal.
    render(<WalletButton />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", ADDRESS);
    expect(button.getAttribute("aria-label")).toContain("0x3Be7…8E41");
    expect(button.getAttribute("aria-label")).toContain("108.28 USDC");
  });

  it("says connected even with nothing in the wallet", () => {
    wallet = { ...wallet, balance: "0" };
    render(<WalletButton />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("asks somebody with no wallet to connect one", () => {
    wallet = { isConnected: false, address: "", balance: "0" };
    render(<WalletButton />);
    expect(screen.getByRole("button")).toHaveTextContent(/connect/i);
  });
});
