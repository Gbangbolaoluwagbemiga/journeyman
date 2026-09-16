import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * THE PAGE A FREELANCER GOES TO WHEN NOBODY HAS TOLD THEM ANYTHING.
 *
 * A notification can be missed — it is written from the client's browser, so it
 * depends on them still having the tab open when the transaction confirms. This
 * list is the thing you can go and check instead, so the states it can be in
 * matter more than how it looks.
 *
 * In particular it must never say "you have applied for nothing" to someone who
 * has applied for six things. An unreachable index is a different sentence from
 * an empty list, and only one of those two is ever true at a time.
 */

const fetchMyApplications = vi.fn();

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xAAAA", isConnected: true } }),
}));
vi.mock("@/lib/atelier/applications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchMyApplications,
}));

const { MyApplications } = await import("@/components/atelier/my-applications");

function job(over: Record<string, unknown> = {}) {
  return {
    escrowId: "5",
    projectTitle: "Coffee Roastery Logo",
    projectDescription: "",
    category: "design",
    totalAmount: "10000000",
    deadline: 0,
    appliedAt: 1_700_000_000,
    outcome: "waiting",
    ...over,
  };
}

function list() {
  return render(
    <MemoryRouter>
      <MyApplications />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMyApplications.mockReset();
  fetchMyApplications.mockResolvedValue([job()]);
});

describe("what it shows", () => {
  it("lists a job you are still waiting on", async () => {
    list();
    expect(await screen.findByTestId("my-applications")).toBeInTheDocument();
    expect(screen.getByText("Coffee Roastery Logo")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-waiting")).toHaveTextContent(/still deciding/i);
  });

  it("counts what is outstanding, since that is the number people come for", async () => {
    fetchMyApplications.mockResolvedValue([job(), job({ escrowId: "6" }), job({ escrowId: "7", outcome: "passed" })]);
    list();
    expect(await screen.findByTestId("waiting-heading")).toHaveTextContent("2");
  });

  it("separates decided applications from outstanding ones", async () => {
    fetchMyApplications.mockResolvedValue([job(), job({ escrowId: "6", outcome: "won" })]);
    list();
    expect(await screen.findByTestId("decided-heading")).toHaveTextContent("1");
  });

  it("shows no Decided section when nothing has been decided", async () => {
    list();
    await screen.findByTestId("my-applications");
    expect(screen.queryByTestId("decided-heading")).not.toBeInTheDocument();
  });

  it("shows the budget in dollars, not raw units", async () => {
    list();
    await screen.findByTestId("my-applications");
    expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
  });

  it("shows the category rather than the marker id", async () => {
    list();
    expect(await screen.findByText("Design & brand")).toBeInTheDocument();
  });
});

/* The outcome a freelancer is owed and was never given: someone else got it. */
describe("each outcome says something a person can act on", () => {
  it.each([
    ["won", /you got it/i],
    ["passed", /went to someone else/i],
    ["withdrawn", /client withdrew/i],
  ])("renders %s in plain words", async (outcome, words) => {
    fetchMyApplications.mockResolvedValue([job({ outcome })]);
    list();
    expect(await screen.findByTestId(`outcome-${outcome}`)).toHaveTextContent(words);
  });
});

describe("when there is nothing to show", () => {
  it("says you have not applied for anything, and points at the board", async () => {
    fetchMyApplications.mockResolvedValue([]);
    list();
    expect(await screen.findByTestId("applications-empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browse jobs/i })).toBeInTheDocument();
  });

  /* The distinction that matters: "you have none" is a claim, and we cannot
     make it when we could not look. */
  it("does not claim you have none when the index is unreachable", async () => {
    fetchMyApplications.mockRejectedValue(new Error("GraphQL HTTP 503"));
    list();
    expect(await screen.findByTestId("applications-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("applications-empty")).not.toBeInTheDocument();
  });

  it("says the applications are still safe on-chain", async () => {
    fetchMyApplications.mockRejectedValue(new Error("boom"));
    list();
    expect(await screen.findByText(/safe on-chain/i)).toBeInTheDocument();
  });

  it("shows a loading state rather than an empty list while it looks", async () => {
    fetchMyApplications.mockReturnValue(new Promise(() => {}));
    list();
    await waitFor(() => expect(screen.getByTestId("applications-loading")).toBeInTheDocument());
    expect(screen.queryByTestId("applications-empty")).not.toBeInTheDocument();
  });
});
