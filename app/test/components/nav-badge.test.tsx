import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * THE DOT ON MY JOBS, AND WHAT IT CLAIMS.
 *
 * It has always meant "somebody applied and is waiting on your decision". It
 * said so only in an aria-label reading "needs your attention", which is not
 * the same sentence and is invisible to anyone using a mouse.
 *
 * So the same person asked why it was lit when every job was finished — it was
 * counting a cancelled job's old applicant, a genuine bug — and then, once that
 * was fixed, why it was dark after posting a new job. The second was correct
 * behaviour read through the wrong meaning: a job nobody has applied to has
 * nothing waiting on it.
 *
 * A signal whose meaning has to be guessed will be guessed wrong, so the dot
 * now carries its reason where both a screen reader and a cursor can find it.
 */

const useFreelancerStatus = vi.fn(() => ({ isFreelancer: false }));
const useJobCreatorStatus = vi.fn(() => ({ isJobCreator: true }));
const usePendingApprovals = vi.fn(() => ({ hasPendingApprovals: false }));

vi.mock("@/hooks/use-freelancer-status", () => ({ useFreelancerStatus }));
vi.mock("@/hooks/use-job-creator-status", () => ({ useJobCreatorStatus }));
vi.mock("@/hooks/use-pending-approvals", () => ({ usePendingApprovals }));
vi.mock("@/hooks/use-admin-status", () => ({
  useAdminStatus: () => ({ isAdmin: false, isArbiter: false }),
}));
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xC11E27", isConnected: true } }),
}));
vi.mock("@/hooks/use-managed-worker", () => ({
  useManagedWorker: () => ({ worker: null }),
}));
/* Everything else in the bar is its own feature with its own provider — the
   bell needs NotificationProvider, the wallet button needs AppKit. The dot is
   what is under test, so the rest of the shell is stubbed out. */
vi.mock("@/components/notification-center", () => ({ NotificationCenter: () => null }));
vi.mock("@/components/atelier/managed-wallet-menu", () => ({ ManagedWalletMenu: () => null }));
vi.mock("@/components/wallet-button", () => ({ WalletButton: () => null }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));

const { Navbar } = await import("@/components/navbar");

const nav = () =>
  render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>,
  );

describe("when a decision is waiting", () => {
  it("lights the dot and says why, in words", () => {
    usePendingApprovals.mockReturnValue({ hasPendingApprovals: true });
    nav();

    const dot = screen.getAllByTestId("nav-badge")[0];
    expect(dot).toHaveAttribute("title", expect.stringMatching(/applied.*waiting on your decision/i));
    expect(dot).toHaveAttribute("aria-label", expect.stringMatching(/waiting on your decision/i));
  });

  /* "Needs your attention" is what it used to say, and it is what let the dot
     be read as "you have an active job". */
  it("does not fall back to a meaning the reader has to supply", () => {
    usePendingApprovals.mockReturnValue({ hasPendingApprovals: true });
    nav();
    expect(screen.getAllByTestId("nav-badge")[0]).not.toHaveAttribute(
      "aria-label",
      "needs your attention",
    );
  });
});

describe("when nothing is waiting", () => {
  it("shows no dot for a client with no applicants to review", () => {
    usePendingApprovals.mockReturnValue({ hasPendingApprovals: false });
    nav();
    expect(screen.queryByTestId("nav-badge")).not.toBeInTheDocument();
  });

  /* The dot is a client's signal. A freelancer approves nothing. */
  it("shows no dot to somebody who posts no jobs", () => {
    useJobCreatorStatus.mockReturnValue({ isJobCreator: false });
    usePendingApprovals.mockReturnValue({ hasPendingApprovals: true });
    nav();
    expect(screen.queryByTestId("nav-badge")).not.toBeInTheDocument();
  });
});
