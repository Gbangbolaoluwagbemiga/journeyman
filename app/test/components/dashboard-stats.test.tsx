import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardStats } from "@/components/dashboard/dashboard-stats";

/**
 * "Total Value" is the first number on My Jobs, and it used to contradict the
 * list directly underneath it: it summed every escrow the client had ever
 * created, at full original value, so cancelling a job left its budget in the
 * headline forever. Reported twice from the running app before it was fixed,
 * which is what these tests are for.
 *
 * The figure means one thing: what the escrow contract is holding right now.
 */

const usdc = (n: number) => String(Math.round(n * 1e6));

function escrow(status: string, total: number, released = 0) {
  return {
    totalAmount: usdc(total),
    releasedAmount: usdc(released),
    status,
    milestones: [] as Array<{ status: string }>,
  };
}

function totalValue() {
  // The first stat card's figure.
  return screen.getByText(/USDC in escrows/i).parentElement?.textContent ?? "";
}

describe("Total Value", () => {
  it("counts money the contract is still holding", () => {
    render(<DashboardStats escrows={[escrow("pending", 5), escrow("active", 8)]} />);
    expect(totalValue()).toContain("13.00");
  });

  it("drops a job once it is cancelled", () => {
    render(<DashboardStats escrows={[escrow("pending", 5), escrow("cancelled", 8)]} />);
    expect(totalValue()).toContain("5.00");
  });

  it.each(["completed", "cancelled", "refunded", "expired"])(
    "treats %s as settled, not held",
    (status) => {
      render(<DashboardStats escrows={[escrow(status, 42)]} />);
      expect(totalValue()).toContain("0.00");
    },
  );

  it("subtracts milestones already paid out of a running job", () => {
    // 10 total, 4 already released — 6 is still in escrow, not 10.
    render(<DashboardStats escrows={[escrow("active", 10, 4)]} />);
    expect(totalValue()).toContain("6.00");
  });

  it("never reports a negative balance", () => {
    // Defensive: released should never exceed total, but a rounding artefact
    // must not render "-0.01 USDC" on the client's dashboard.
    render(<DashboardStats escrows={[escrow("active", 5, 5.01)]} />);
    expect(totalValue()).toContain("0.00");
  });

  it("keeps Released as a lifetime figure, including settled jobs", () => {
    // "What have I paid out" does not go stale when a job finishes.
    render(<DashboardStats escrows={[escrow("completed", 9, 9)]} />);
    expect(screen.getByText(/USDC released/i).parentElement?.textContent).toContain("9.00");
  });
});
