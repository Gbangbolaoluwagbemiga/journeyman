import { describe, it, expect } from "vitest";
import {
  PRIMARY_NAV,
  isCurrent,
  visibleNav,
  type NavRoles,
} from "@/lib/atelier/nav";

const NOBODY: NavRoles = {
  hasOwnWallet: false,
  hasManagedAccount: false,
  isFreelancer: false,
  isClient: false,
  isArbiter: false,
  isAdmin: false,
};

describe("visibleNav", () => {
  it("shows a first-time visitor only the unconditional entries", () => {
    expect(visibleNav(NOBODY).map((i) => i.to)).toEqual([
      "/jobs",
      "/get-hired",
      "/post",
      "/analytics",
    ]);
  });

  /**
   * Browse Jobs and Post a Job must survive every role combination. They are
   * the two doors into the marketplace: hide either behind a role and a new
   * wallet lands on an app with nothing to do.
   */
  it("always offers a way in and a way to post", () => {
    const combos: NavRoles[] = [
      NOBODY,
      { ...NOBODY, isFreelancer: true },
      { ...NOBODY, isClient: true },
      { ...NOBODY, isArbiter: true, isAdmin: true },
      { isFreelancer: true, isClient: true, isArbiter: true, isAdmin: true },
    ];
    for (const roles of combos) {
      const paths = visibleNav(roles).map((i) => i.to);
      expect(paths).toContain("/jobs");
      expect(paths).toContain("/post");
      // Get Hired survives every ROLE combination — hiding it by role would
      // hide it from the people it exists for. It is hidden by WALLET instead,
      // which is tested separately below.
      expect(paths).toContain("/get-hired");
    }
  });

  /**
   * My Jobs is one destination for both sides of the table. Either role earns
   * it, and the page itself decides whether to show tabs — so the nav must not
   * try to distinguish them.
   */
  it("shows My Jobs to either side of the table", () => {
    expect(visibleNav({ ...NOBODY, isFreelancer: true }).map((i) => i.to)).toContain("/my-jobs");
    expect(visibleNav({ ...NOBODY, isClient: true }).map((i) => i.to)).toContain("/my-jobs");
  });

  it("offers it exactly once to someone with both roles", () => {
    const paths = visibleNav({
      isFreelancer: true,
      isClient: true,
      isArbiter: false,
      isAdmin: false,
    }).map((i) => i.to);
    expect(paths.filter((p) => p === "/my-jobs")).toHaveLength(1);
  });

  it("hides My Jobs from someone who has neither posted nor been hired", () => {
    expect(visibleNav(NOBODY).map((i) => i.to)).not.toContain("/my-jobs");
  });

  /**
   * Get Hired is an ENTRANCE, and an entrance is clutter once you are inside.
   * A wallet user signs for themselves and has no use for it; a signed-in
   * managed worker already reaches the same page from their wallet menu.
   */
  it("hides Get Hired once a wallet of their own is connected", () => {
    const paths = visibleNav({ ...NOBODY, hasOwnWallet: true }).map((i) => i.to);
    expect(paths).not.toContain("/get-hired");
  });

  /**
   * THE ENTRANCE GOES; THE HOME ARRIVES.
   *
   * /get-hired was tagged signed-out only, so a managed worker lost the link to
   * their own board the moment they signed in — their jobs, their balance and
   * the Withdraw button reachable only from a dropdown behind their address.
   * The door and the room are not the same link, even when they share a path.
   */
  it("swaps Get Hired for My Work once signed in with a managed account", () => {
    const items = visibleNav({ ...NOBODY, hasManagedAccount: true });
    const labels = items.map((i) => i.label);

    expect(labels).not.toContain("Get Hired");
    expect(labels).toContain("My Work");
    // Same destination — it is their board either way.
    expect(items.find((i) => i.label === "My Work")?.to).toBe("/get-hired");
  });

  it("gives a wallet user My Jobs instead, not both", () => {
    // My Jobs already serves this purpose for somebody holding their own keys;
    // a second entry pointing at the managed board would be noise.
    const labels = visibleNav({
      ...NOBODY,
      hasOwnWallet: true,
      hasManagedAccount: true,
      isFreelancer: true,
    }).map((i) => i.label);

    expect(labels).not.toContain("My Work");
    expect(labels).toContain("My Jobs");
  });

  /**
   * But it must survive being a freelancer with neither — that is somebody who
   * applied through Telegram, say, and is now on the web with no session. They
   * are exactly who the door exists for.
   */
  it("still shows it to a freelancer with no account in this browser", () => {
    const paths = visibleNav({ ...NOBODY, isFreelancer: true }).map((i) => i.to);
    expect(paths).toContain("/get-hired");
  });

  it("reveals admin only to an admin", () => {
    expect(visibleNav({ ...NOBODY, isAdmin: true }).map((i) => i.to)).toContain("/admin");
  });

  /**
   * Disputes is arbitration — a staff tool reached from Admin, not a place a
   * client or freelancer navigates to. It must not reappear in the nav for
   * anyone, including an arbiter, who gets there through Admin.
   */
  it("never puts Disputes in the nav, for any role", () => {
    const everyone: NavRoles[] = [
      NOBODY,
      { ...NOBODY, isFreelancer: true },
      { ...NOBODY, isClient: true },
      { ...NOBODY, isArbiter: true },
      { isFreelancer: true, isClient: true, isArbiter: true, isAdmin: true },
    ];
    for (const roles of everyone) {
      expect(visibleNav(roles).map((i) => i.to)).not.toContain("/disputes");
    }
  });

  it("keeps admin out of an ordinary user's nav", () => {
    const paths = visibleNav({
      isFreelancer: true,
      isClient: true,
      isArbiter: false,
      isAdmin: false,
    }).map((i) => i.to);
    expect(paths).not.toContain("/admin");
  });

  it("preserves declaration order regardless of roles", () => {
    const all = visibleNav({
      hasManagedAccount: true,
      isFreelancer: true,
      isClient: true,
      isArbiter: true,
      isAdmin: true,
    });
    /* Every entry this person can see, in declaration order. Get Hired is the
       one they cannot — it is for somebody with no account at all. */
    expect(all.map((i) => i.to)).toEqual(
      PRIMARY_NAV.filter((i) => i.visibility !== "signed-out").map((i) => i.to),
    );
  });
});

describe("isCurrent", () => {
  it("lights a nav item on its own route", () => {
    expect(isCurrent("/jobs", "/jobs")).toBe(true);
  });

  it("stays lit on a child route", () => {
    expect(isCurrent("/my-jobs/42", "/my-jobs")).toBe(true);
    expect(isCurrent("/post/autopilot", "/post")).toBe(true);
  });

  /**
   * The case a naive startsWith gets wrong: "/work" must not light on
   * "/workspace", and "/" must not light on everything.
   */
  it("does not match a route that merely shares a prefix", () => {
    expect(isCurrent("/workspace", "/work")).toBe(false);
    expect(isCurrent("/jobsy", "/jobs")).toBe(false);
  });

  it("lights home only on home", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/jobs", "/")).toBe(false);
  });
});


/**
 * A CONVERSATION NEEDS A DOOR, BUT NOT A NAV ENTRY.
 *
 * Messages had a page, a table, an inbox endpoint and no way in: the only link
 * was on the old freelancer dashboard, which a managed worker never sees. A
 * direct message was deliverable and unreadable at the same time.
 *
 * The first fix was a sixth nav entry, and it was the wrong half of the
 * problem. The bar holds five — navbar.tsx carries a note about the fifth
 * making "Browse Jobs" and "Post a Job" wrap on a narrow laptop — and this list
 * is places you GO to do work. A message ARRIVES, like a notification, and the
 * bell beside it had already settled what that looks like.
 *
 * So the door is an icon in the header with an unread count, and these tests
 * guard the decision rather than the entry that briefly implemented it.
 */
describe("the way into Messages", () => {
  const labels = (roles: Parameters<typeof visibleNav>[0]) =>
    visibleNav(roles).map((i) => i.label);

  const nobody = {
    isFreelancer: false,
    isClient: false,
    isArbiter: false,
    isAdmin: false,
  };

  it("is not a nav entry — it lives in the header", () => {
    expect(labels({ ...nobody, hasOwnWallet: true })).not.toContain("Messages");
    expect(labels({ ...nobody, hasManagedAccount: true })).not.toContain("Messages");
  });

  it("leaves the bar at five for somebody using both sides of the market", () => {
    // Six is where "Browse Jobs" and "Post a Job" start wrapping.
    const full = visibleNav({
      hasOwnWallet: true,
      isFreelancer: true,
      isClient: true,
      isArbiter: false,
      isAdmin: false,
    });
    expect(full.length).toBeLessThanOrEqual(5);
  });

  it("still routes /messages, for the link and the bookmark", () => {
    // Not in the nav is not the same as gone: FreelancerPage links to it.
    expect(PRIMARY_NAV.some((i) => i.to === "/messages")).toBe(false);
    expect(isCurrent("/messages", "/messages")).toBe(true);
  });
});
