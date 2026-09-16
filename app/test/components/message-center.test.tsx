import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * MESSAGES AS AN ICON, NOT A DESTINATION.
 *
 * A message arrives; it is not somewhere you go. The nav lists places you go to
 * do work, and adding Messages made six entries in a bar that wraps at six.
 * This is the bell's shape applied to the thing next to the bell.
 */

const getInbox = vi.fn();
vi.mock("@/lib/api", () => ({
  getInbox: (w: string) => getInbox(w),
  isApiConfigured: () => true,
}));

let myAddress: string | null = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";
vi.mock("@/hooks/use-my-address", () => ({
  useMyAddress: () => myAddress,
}));

vi.mock("@/components/chat/chat-dialog", () => ({
  ChatDialog: ({ open, otherAddress }: { open: boolean; otherAddress: string }) =>
    open ? <div data-testid="chat">chat with {otherAddress}</div> : null,
}));

const { MessageCenter } = await import("@/components/message-center");

const THREAD = {
  conversation_id: "a:b",
  other_address: "0x3be7fbbdbc73fc4731d60ef09c4ba1a94dc58e41",
  latest_message: "Hiiiii",
  latest_at: new Date(Date.now() - 3_600_000).toISOString(),
  unread: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  myAddress = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";
  getInbox.mockResolvedValue([THREAD]);
});

describe("the message icon", () => {
  it("shows how many are unread without being opened", async () => {
    render(<MessageCenter />);
    expect(await screen.findByLabelText(/1 unread/i)).toBeInTheDocument();
  });

  it("asks for the managed worker's inbox, not a connected wallet's", async () => {
    // A managed worker never connects a wallet; they are the half of the market
    // with no other channel, so theirs is the inbox that most has to work.
    render(<MessageCenter />);
    await waitFor(() =>
      expect(getInbox).toHaveBeenCalledWith("0x8289da3f656fb9afb94e1074c7e88f0ad98ac423"),
    );
  });

  it("carries no badge when nothing is waiting", async () => {
    getInbox.mockResolvedValue([{ ...THREAD, unread: 0 }]);
    render(<MessageCenter />);
    expect(await screen.findByLabelText(/^Messages$/i)).toBeInTheDocument();
  });

  it("opens the conversation from the list", async () => {
    render(<MessageCenter />);
    await userEvent.click(await screen.findByLabelText(/messages/i));
    await userEvent.click(await screen.findByText(/Hiiiii/));
    expect(await screen.findByTestId("chat")).toHaveTextContent(THREAD.other_address);
  });

  it("renders nothing for a visitor who is nobody", () => {
    myAddress = null;
    const { container } = render(<MessageCenter />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the list it had when a poll fails", async () => {
    // An icon that empties itself because one read blinked is worse than a
    // stale one — the same rule the rest of this app now holds to.
    render(<MessageCenter />);
    await screen.findByLabelText(/1 unread/i);

    getInbox.mockRejectedValue(new Error("rate limit exceeded"));
    await new Promise((r) => setTimeout(r, 10));

    expect(screen.getByLabelText(/1 unread/i)).toBeInTheDocument();
  });
});
