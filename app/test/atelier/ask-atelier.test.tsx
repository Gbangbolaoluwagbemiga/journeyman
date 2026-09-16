import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

/**
 * The question box people can type anything into.
 *
 * The behaviour worth pinning is what happens around the answer: that a failed
 * assistant does not read as a broken app, that the panel can always be
 * escaped, and that it never implies it can act — Atelier's argument is that
 * nobody has to be trusted, and a box that offers to move money for you argues
 * the opposite.
 */

const askAtelier = vi.fn();
class AssistantBusy extends Error {}

vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  AssistantBusy,
  askAtelier: (m: unknown, v: unknown) => askAtelier(m, v),
}));

const { AskAtelier } = await import("@/components/atelier/ask-atelier");

const show = (viewer?: unknown) =>
  render(
    <MemoryRouter initialEntries={["/jobs"]}>
      <AskAtelier viewer={viewer as never} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  askAtelier.mockResolvedValue("The budget is locked in escrow from the moment the job is created.");
});

describe("opening it", () => {
  it("stays out of the way until asked for", () => {
    show();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask atelier/i })).toBeInTheDocument();
  });

  it("offers the questions people are actually nervous about", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/take the money back/i)).toBeInTheDocument();
  });

  it("says up front that it explains rather than acts", async () => {
    // A box anyone can type into must not look like it can move money.
    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));

    expect(await screen.findByText(/can't move money or act on a job/i)).toBeInTheDocument();
  });

  it("dims the page behind it, so the two do not dissolve into each other", async () => {
    // The translucent panel this replaced sat on a dark page and you could not
    // tell where the conversation ended and the job board began.
    const { container } = show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await screen.findByRole("dialog");

    expect(container.querySelector('[aria-hidden="true"].fixed.inset-0')).toBeTruthy();
  });

  it("closes when the dimmed page is clicked", async () => {
    const { container } = show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await screen.findByRole("dialog");

    const scrim = container.querySelector('[aria-hidden="true"].fixed.inset-0') as HTMLElement;
    await userEvent.click(scrim);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes on Escape, because a panel that traps you is worse than none", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await screen.findByRole("dialog");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("asking", () => {
  it("sends the question and shows the answer", async () => {
    show({ role: "freelancer" });
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await userEvent.type(await screen.findByLabelText(/your question/i), "Is my money safe?");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByText(/locked in escrow/i)).toBeInTheDocument();
  });

  it("tells the assistant who is asking and from where", async () => {
    show({ role: "freelancer", working: 1 });
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await userEvent.click(await screen.findByText(/take the money back/i));

    await waitFor(() => expect(askAtelier).toHaveBeenCalled());
    expect(askAtelier.mock.calls[0][1]).toMatchObject({
      role: "freelancer",
      working: 1,
      page: "Browse Jobs",
    });
  });

  it("sends on Enter, and keeps Shift+Enter for a new line", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    const box = await screen.findByLabelText(/your question/i);

    await userEvent.type(box, "first line{Shift>}{Enter}{/Shift}second line");
    expect(askAtelier).not.toHaveBeenCalled();

    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(askAtelier).toHaveBeenCalled());
  });

  it("will not send an empty question", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    expect(await screen.findByRole("button", { name: /^send$/i })).toBeDisabled();
  });
});

describe("when it cannot answer", () => {
  it("says the rest of Atelier is fine, because it is", async () => {
    // The assistant is a convenience. A failure here must not read as the
    // marketplace being down.
    askAtelier.mockRejectedValue(new Error("offline"));

    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await userEvent.click(await screen.findByText(/take the money back/i));

    expect(await screen.findByText(/everything else on atelier works normally/i)).toBeInTheDocument();
  });

  it("passes on the rate-limit message rather than burying it", async () => {
    askAtelier.mockRejectedValue(new AssistantBusy("That is a lot of questions at once."));

    show();
    await userEvent.click(screen.getByRole("button", { name: /ask atelier/i }));
    await userEvent.click(await screen.findByText(/take the money back/i));

    expect(await screen.findByText(/a lot of questions at once/i)).toBeInTheDocument();
  });
});
