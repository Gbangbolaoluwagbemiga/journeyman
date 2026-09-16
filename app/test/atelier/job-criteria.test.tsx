import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * THE WEB SAYING WHAT TELEGRAM ALREADY SAID.
 *
 * The bot has printed a job's acceptance criteria since it existed. The web
 * card printed a title, a budget and a description — so the same commission
 * read as two different jobs depending on where you found it, and the web was
 * the half missing the answer to "what do I actually have to deliver".
 *
 * On an agent-run job that gap is not cosmetic. An agent approves or rejects a
 * submission against these exact lines. A freelancer who cannot read them is
 * being marked against a rubric nobody showed them.
 */

const fetchJobCriteria = vi.fn();
vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchJobCriteria: (id: number, signal?: AbortSignal) => fetchJobCriteria(id, signal),
}));

const { JobCriteria } = await import("@/components/jobs/job-criteria");

beforeEach(() => {
  fetchJobCriteria.mockReset();
  fetchJobCriteria.mockResolvedValue({
    criteria: ["Delivered as SVG and PNG", "Minimum 1000x1000px"],
    source: "approved",
    applicationWindowMinutes: 3,
  });
});

describe("what the freelancer is measured against", () => {
  it("lists the criteria for an agent-run job", async () => {
    render(<JobCriteria escrowId={7} managedByAgent />);

    expect(await screen.findByText("Delivered as SVG and PNG")).toBeInTheDocument();
    expect(screen.getByText("Minimum 1000x1000px")).toBeInTheDocument();
    // The consequence, said out loud — this is what releases the money.
    expect(screen.getByText(/releases the milestone payment/i)).toBeInTheDocument();
  });

  it("says plainly when a job has none written down", async () => {
    fetchJobCriteria.mockResolvedValue({ criteria: [], source: "none", applicationWindowMinutes: 3 });
    render(<JobCriteria escrowId={7} managedByAgent />);

    // Real information for someone deciding whether to spend an hour on a
    // cover letter: the description IS the brief.
    expect(await screen.findByText(/no acceptance criteria are written into this job/i)).toBeInTheDocument();
  });

  it("shows nothing at all on a client-run job", () => {
    // A person reading a description judges differently from an agent scoring
    // a rubric. An empty criteria box would imply a rubric exists.
    render(<JobCriteria escrowId={7} managedByAgent={false} />);

    expect(screen.queryByText(/judged on/i)).not.toBeInTheDocument();
    expect(fetchJobCriteria).not.toHaveBeenCalled();
  });

  it("asks for nothing when there is no job yet", () => {
    render(<JobCriteria escrowId={null} managedByAgent />);
    expect(fetchJobCriteria).not.toHaveBeenCalled();
  });

  it("stays out of the way when the daemon cannot answer", async () => {
    // A broken box above the cover letter helps nobody apply.
    fetchJobCriteria.mockRejectedValue(new Error("offline"));
    render(<JobCriteria escrowId={7} managedByAgent />);

    await vi.waitFor(() =>
      expect(screen.queryByText(/judged on/i)).not.toBeInTheDocument(),
    );
  });
});
