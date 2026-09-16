import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * WHAT A FREELANCER LEARNS FROM A JOB CARD BEFORE THEY CLICK IT.
 *
 * The board is a wall of near-identical cards, and each badge here is a reason
 * to pick one over another: what kind of work it is, whether the escrow pays a
 * bonus on top of the budget, whether the job has a history worth knowing about.
 *
 * The Earning badge in particular was shipped untested, reading a number that
 * nothing in the app could set. It rendered on no job, ever, and the suite was
 * green throughout. Its two cases are the point of this file: it must appear
 * when money really is deployed, and must not appear otherwise — a badge that
 * over-promises a bonus costs a freelancer money they were counting on.
 */

const isEarningYield = vi.fn();
const getAverageClientRating = vi.fn().mockResolvedValue({ averageX100: 0, count: 0 });

vi.mock("framer-motion", () => ({
  motion: { div: (p: Record<string, unknown>) => <div {...p} /> },
}));
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: class {
    isEarningYield = isEarningYield;
    getAverageClientRating = getAverageClientRating;
  },
}));

const { JobCard } = await import("@/components/jobs/job-card");

const usdc = (n: number) => String(Math.round(n * 1e6));

function job(over: Record<string, unknown> = {}) {
  return {
    id: 4,
    payer: "0x1111111111111111111111111111111111111111",
    beneficiary: "0x0000000000000000000000000000000000000000",
    projectTitle: "A logo for a coffee roastery",
    projectDescription: "[category:design]\nSomething warm and a bit hand-drawn.",
    amount: usdc(50),
    token: "0x0000000000000000000000000000000000000000",
    duration: 259200,
    status: "pending",
    isOpenJob: true,
    milestones: [{ description: "Concepts", amount: usdc(50), status: "pending" }],
    ...over,
  } as never;
}

function card(over: Record<string, unknown> = {}) {
  return render(
    <JobCard
      job={job(over)}
      index={0}
      hasApplied={false}
      isContractPaused={false}
      ongoingProjectsCount={0}
      onApply={() => {}}
    />,
  );
}

beforeEach(() => {
  isEarningYield.mockResolvedValue(false);
});

describe("the Earning badge", () => {
  it("appears on a job whose escrow earns, before anyone is hired", async () => {
    isEarningYield.mockResolvedValue(true);
    card();
    expect(await screen.findByTestId("earning-badge")).toHaveTextContent(/earning/i);
  });

  it("stays off on a job posted without it", async () => {
    card();
    await waitFor(() => expect(isEarningYield).toHaveBeenCalled());
    expect(screen.queryByTestId("earning-badge")).not.toBeInTheDocument();
  });

  /* A read that fails must not be read as "yes" — a tag promising a bonus that
     never arrives costs a freelancer money they were counting on. */
  it("stays off when the chain read fails", async () => {
    isEarningYield.mockRejectedValue(new Error("network"));
    card();
    await waitFor(() => expect(isEarningYield).toHaveBeenCalled());
    expect(screen.queryByTestId("earning-badge")).not.toBeInTheDocument();
  });

  it("explains what it means on hover, since a sprout icon does not", async () => {
    isEarningYield.mockResolvedValue(true);
    card();
    const badge = await screen.findByTestId("earning-badge");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/larger share/i));
  });

  it("asks about this job, not some other one", async () => {
    card({ id: 17 });
    await waitFor(() => expect(isEarningYield).toHaveBeenCalledWith(17));
  });
});

describe("the category badge", () => {
  it("shows the human label rather than the marker id", async () => {
    card();
    expect(await screen.findByTestId("category-badge")).toHaveTextContent("Design & brand");
  });

  it("shows nothing for a job posted before categories existed", async () => {
    card({ projectDescription: "Something warm and a bit hand-drawn." });
    await waitFor(() => expect(isEarningYield).toHaveBeenCalled());
    expect(screen.queryByTestId("category-badge")).not.toBeInTheDocument();
  });

  /* Nobody should ever read "[category:design]" on a job board. */
  it("never leaks the marker into the description a person reads", async () => {
    card();
    await screen.findByTestId("category-badge");
    expect(document.body.textContent).not.toContain("[category:");
  });
});
