import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "@/components/error-boundary";

/**
 * A CRASH SHOULD SAY WHAT IT WAS.
 *
 * React unmounts the whole tree when a component throws, so before this the
 * failure mode was a black rectangle: no navbar, no message, nothing to search
 * for. It cost a day on Browse Jobs — a hook called inside a `.map()` — and
 * showed up again on My Jobs, and in both cases the first ten minutes went on
 * establishing that the page had crashed at all rather than failed to deploy.
 *
 * So the thing under test is not the styling. It is: does the message survive,
 * and does one broken page stay one broken page.
 */

function Boom({ message = "Cannot read properties of undefined" }: { message?: string }) {
  throw new Error(message);
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React logs the caught error itself; silence it so the run stays readable.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe("when a page throws", () => {
  it("shows the error's own message rather than a blank page", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByTestId("error-message")).toHaveTextContent(
      /Cannot read properties of undefined/,
    );
  });

  /* The first thing a user thinks when a page vanishes is that their money went
     with it. It did not, and saying so costs one sentence. */
  it("says the on-chain state is unaffected", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText(/nothing on-chain is affected/i)).toBeInTheDocument();
  });

  it("still logs to the console, which is where a deployed build is debugged", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(consoleError).toHaveBeenCalledWith(
      "[Atelier] render crash:",
      expect.any(Error),
      expect.anything(),
    );
  });

  it("offers a way out that is not the browser's reload button", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole("button", { name: /try again without reloading/i })).toBeInTheDocument();
  });
});

describe("when nothing throws", () => {
  it("renders the page and nothing of its own", () => {
    render(<ErrorBoundary><p>the actual page</p></ErrorBoundary>);
    expect(screen.getByText("the actual page")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary")).not.toBeInTheDocument();
  });
});

/**
 * One crash must not make the whole app look broken. Without the reset, every
 * route visited after a crash renders the first page's error.
 */
describe("navigating away", () => {
  it("clears the error when the route changes", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/my-jobs"><Boom /></ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();

    rerender(<ErrorBoundary resetKey="/jobs"><p>browse jobs</p></ErrorBoundary>);
    expect(screen.getByText("browse jobs")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary")).not.toBeInTheDocument();
  });

  it("keeps showing the error while you stay on the same route", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/my-jobs"><Boom /></ErrorBoundary>,
    );
    rerender(<ErrorBoundary resetKey="/my-jobs"><p>never reached</p></ErrorBoundary>);
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();
  });

  it("recovers when the user retries and the cause is gone", async () => {
    const { rerender } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    rerender(<ErrorBoundary><p>fixed now</p></ErrorBoundary>);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("fixed now")).toBeInTheDocument();
  });
});
