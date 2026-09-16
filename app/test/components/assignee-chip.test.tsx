import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssigneeChip } from "@/components/atelier/assignee-chip";

/**
 * WHO IS ON THIS JOB.
 *
 * The address was on chain the whole time and nowhere on the card, so telling
 * two assigned jobs apart — or checking you hired the person you meant to —
 * meant opening a block explorer.
 *
 * Six characters and four: enough to recognise an address you already know,
 * not enough to mistake for one you don't.
 */

const WORKER = "0xfC3642978a1a46ff751ee259906E07ddD7d43Bd1";
const ZERO = "0x0000000000000000000000000000000000000000";

async function openTooltip(el: HTMLElement) {
  fireEvent.pointerMove(el, { pointerType: "mouse" });
  fireEvent.focus(el);
}

describe("what it shows at a glance", () => {
  it("abbreviates the address", () => {
    render(<AssigneeChip address={WORKER} />);
    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("0xfC36…3Bd1");
  });

  /* A hover is not available to everyone, so the whole address is in the label. */
  it("puts the full address where a screen reader will find it", () => {
    render(<AssigneeChip address={WORKER} />);
    expect(screen.getByLabelText(`Freelancer: ${WORKER}`)).toBeInTheDocument();
  });

  it("names the side it is showing, since both sides see a card", () => {
    render(<AssigneeChip address={WORKER} label="Client" />);
    expect(screen.getByLabelText(`Client: ${WORKER}`)).toBeInTheDocument();
  });
});

describe("what it shows on hover", () => {
  it("gives the whole address", async () => {
    render(<AssigneeChip address={WORKER} />);
    await openTooltip(screen.getByTestId("assignee-chip"));
    const full = await screen.findAllByTestId("assignee-full");
    expect(full[0]).toHaveTextContent(WORKER);
  });

  /* The reason to want all forty characters is nearly always to paste them. */
  it("copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<AssigneeChip address={WORKER} />);
    await openTooltip(screen.getByTestId("assignee-chip"));
    await userEvent.click((await screen.findAllByTestId("assignee-copy"))[0]);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(WORKER));
  });

  /* A browser that refuses clipboard access is not worth an error: the address
     is on screen and can be selected by hand. */
  it("does not blow up when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(<AssigneeChip address={WORKER} />);
    await openTooltip(screen.getByTestId("assignee-chip"));
    await userEvent.click((await screen.findAllByTestId("assignee-copy"))[0]);

    expect(screen.getByTestId("assignee-chip")).toBeInTheDocument();
  });
});

/* An open job has no answer to give, and a placeholder is worse than silence. */
describe("when there is nobody to show", () => {
  it("renders nothing for an unassigned job", () => {
    const { container } = render(<AssigneeChip address={ZERO} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the address is missing entirely", () => {
    const { container } = render(<AssigneeChip />);
    expect(container).toBeEmptyDOMElement();
  });
});
