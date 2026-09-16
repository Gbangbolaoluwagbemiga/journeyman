import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { useNotificationsMock } = vi.hoisted(() => ({
  useNotificationsMock: vi.fn(),
}));

vi.mock("@/contexts/notification-context", () => ({
  useNotifications: useNotificationsMock,
}));

import { NotificationCenter } from "@/components/notification-center";

const LONG_MESSAGE =
  "This is a long arbiter message that goes well past two lines of wrapped text so the notification list would otherwise truncate it with no way to read the rest of what the admin actually said about this dispute.";

function baseState(overrides: Partial<ReturnType<typeof useNotificationsMock>> = {}) {
  return {
    notifications: [],
    unreadCount: 0,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    clearNotifications: vi.fn(),
    removeNotification: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useNotificationsMock.mockReset();
  // jsdom doesn't implement navigation — without this, clicking a row with
  // an actionUrl throws "Not implemented: navigation".
  delete (window as any).location;
  (window as any).location = { href: "" };
});

describe("NotificationCenter — full-message view for long notifications", () => {
  it("lets the user expand a truncated message without navigating away", async () => {
    const user = userEvent.setup();
    useNotificationsMock.mockReturnValue(
      baseState({
        unreadCount: 1,
        notifications: [
          {
            id: "n1",
            type: "dispute",
            title: "Admin Message: Landing Page Redesign",
            message: LONG_MESSAGE,
            timestamp: new Date(),
            read: false,
            actionUrl: "/dashboard?escrow=1",
          },
        ],
      }),
    );

    render(<NotificationCenter />);
    await user.click(screen.getByRole("button")); // bell trigger (only button before the dropdown opens)

    const messageEl = screen.getByText(LONG_MESSAGE);
    expect(messageEl.className).toContain("line-clamp-2");

    const readMoreBtn = screen.getByRole("button", { name: /read full message/i });
    await user.click(readMoreBtn);

    // Expanding must NOT trigger the row's navigate-away handler.
    expect(window.location.href).toBe("");
    expect(messageEl.className).not.toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();
  });

  it("does not show a 'Read full message' toggle for short messages", async () => {
    const user = userEvent.setup();
    useNotificationsMock.mockReturnValue(
      baseState({
        unreadCount: 1,
        notifications: [
          {
            id: "n2",
            type: "application",
            title: "Job Cancelled",
            message: "Short notice.",
            timestamp: new Date(),
            read: false,
          },
        ],
      }),
    );

    render(<NotificationCenter />);
    await user.click(screen.getByRole("button"));

    expect(screen.queryByRole("button", { name: /read full message/i })).not.toBeInTheDocument();
  });

  it("still navigates when the row itself (not the message) is clicked", async () => {
    const user = userEvent.setup();
    const markAsRead = vi.fn();
    useNotificationsMock.mockReturnValue(
      baseState({
        unreadCount: 1,
        markAsRead,
        notifications: [
          {
            id: "n3",
            type: "application",
            title: "Job Cancelled",
            message: "Short notice.",
            timestamp: new Date(),
            read: false,
            actionUrl: "/browse-jobs",
          },
        ],
      }),
    );

    render(<NotificationCenter />);
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByText("Job Cancelled"));

    expect(markAsRead).toHaveBeenCalledWith("n3");
    expect(window.location.href).toBe("/browse-jobs");
  });
});
