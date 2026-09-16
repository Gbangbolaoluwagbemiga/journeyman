/**
 * ATELIER — the information architecture, as data.
 *
 * One app. The freelancer experience is singular; only the client area has
 * modes. That shape is the product decision the merge rests on, so it is
 * written down once, here, rather than spread across duplicated <Link> blocks
 * in a desktop nav and a mobile nav that drift apart.
 *
 *   Browse Jobs   one list. Agent-run and human-run jobs sit together, but an
 *                 agent-run one carries a badge — a freelancer deciding whether
 *                 to spend two days on a job should know who reviews it.
 *   My Work       the freelancer side: applications, active jobs, earnings.
 *   Post a Job    where the client chooses Manual or Autopilot.
 *   My Jobs       the client side. Manual jobs get the milestone review UI;
 *                 Autopilot jobs get the decision log.
 *   Analytics     platform and personal figures.
 *   Disputes      arbitration, for the people who do it.
 *
 * Atelier's original routes still resolve — see the redirects in App.tsx —
 * because there are live users with bookmarks and a deployed app that links
 * into /create and /dashboard.
 */

export interface NavItem {
  /** Route path. */
  to: string;
  /** Label in the nav. */
  label: string;
  /**
   * Which role this belongs to. Everything unconditional is `always`; the rest
   * appears when the connected wallet has earned it, which is how the nav stays
   * short for a first-time visitor.
   */
  visibility:
    | "always"
    | "participant"
    | "freelancer"
    | "client"
    | "arbiter"
    | "admin"
    /** Only for a visitor with no account at all — no wallet, no managed session. */
    | "signed-out"
    /**
     * Only for somebody signed in with a managed Circle wallet.
     *
     * Their work and their money live on /get-hired, and that route was tagged
     * "signed-out" — an entrance, hidden once you are inside. Which left a
     * managed worker signed in with no link to their own board: their jobs,
     * their balance and the Withdraw button were reachable only from a dropdown
     * behind their address. The entrance and the home are not the same link.
     */
    | "managed";
}

/**
 * The primary nav, in order. Order is meaningful: browse before post, because
 * the marketplace has to look alive before anyone will fund an escrow into it.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/jobs", label: "Browse Jobs", visibility: "always" },
  /*
   * The door in, shown only to somebody who has not come through one yet.
   *
   * It is for a person who has never held a private key, so gating it on being
   * a freelancer would hide it from everyone it was built for. But it is an
   * ENTRANCE, and an entrance is clutter once you are inside: a wallet user
   * signs for themselves and has no use for it, and a signed-in managed worker
   * already reaches the same page from their wallet menu.
   *
   * So it disappears the moment there is an account of either kind.
   */
  { to: "/get-hired", label: "Get Hired", visibility: "signed-out" },
  /* The same page, for somebody who is already inside it — their work, their
     earnings, and the button that moves the money out. */
  { to: "/get-hired", label: "My Work", visibility: "managed" },
  { to: "/post", label: "Post a Job", visibility: "always" },
  /*
   * One destination for both sides of the table.
   *
   * "My Work" and "My Jobs" used to be separate entries, which made sense to
   * whoever built it and to nobody using it — most people here hire someone one
   * week and take a job the next, and two nav entries meant two dashboards and
   * two places to check whether anything needed them. The page shows tabs only
   * when you actually have both roles.
   */
  { to: "/my-jobs", label: "My Jobs", visibility: "participant" },
  /*
   * Messages is NOT here, and was for about an hour.
   *
   * It had a page, a table, an inbox endpoint and no way in — the only link was
   * on the old freelancer dashboard, which a managed worker never sees, so a
   * direct message was deliverable and unreadable at the same time. Adding a
   * nav entry fixed the wrong half of that.
   *
   * The bar holds five; this was the sixth, and the note in navbar.tsx about
   * "Browse Jobs" and "Post a Job" wrapping onto two lines was written when the
   * fifth went in. It is also the wrong shape for this list, which is places
   * you GO to do work. A message ARRIVES — same as a notification, and the bell
   * had already settled what that looks like.
   *
   * So it is an icon in the header with an unread count, beside the bell:
   * `message-center.tsx`. The route stays alive for the freelancer page's link
   * and anyone's bookmark; it is simply no longer the only door.
   */
  { to: "/analytics", label: "Analytics", visibility: "always" },
  /*
   * Disputes is NOT here. It is arbitration — a staff tool, not a place a
   * client or freelancer navigates to. It lives behind Admin, which is where it
   * was before and where the link back to it still points. Someone in a dispute
   * reaches it from the job itself, which is the context they need anyway.
   */
  { to: "/admin", label: "Admin", visibility: "admin" },
] as const;

/** What the connected wallet is entitled to see. */
export interface NavRoles {
  /** True once the visitor has connected a wallet they control. */
  hasOwnWallet?: boolean;
  /** True once they are signed in with a managed Circle wallet. */
  hasManagedAccount?: boolean;
  isFreelancer: boolean;
  isClient: boolean;
  isArbiter: boolean;
  isAdmin: boolean;
}

export function visibleNav(
  roles: NavRoles,
  items: readonly NavItem[] = PRIMARY_NAV,
): NavItem[] {
  return items.filter((item) => {
    switch (item.visibility) {
      case "always":
        return true;
      // Either side of the table. My Jobs sorts out which tabs to show.
      case "participant":
        return roles.isFreelancer || roles.isClient;
      case "signed-out":
        return !roles.hasOwnWallet && !roles.hasManagedAccount;
      /* A wallet user has My Jobs for the same purpose and does not need a
         second entry pointing at the managed-worker board. */
      case "managed":
        return roles.hasManagedAccount === true && !roles.hasOwnWallet;
      case "freelancer":
        return roles.isFreelancer;
      case "client":
        return roles.isClient;
      case "arbiter":
        return roles.isArbiter;
      case "admin":
        return roles.isAdmin;
    }
  });
}

/**
 * Whether a nav item should read as current.
 *
 * Prefix matching, so /my-jobs/42 keeps "My Jobs" lit — except for "/", which
 * would otherwise match everything.
 */
export function isCurrent(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Atelier's original paths, kept alive.
 *
 * These are not dead weight: the deployed app, the README, the subgraph docs
 * and at least one live user's bookmarks all point at them. Breaking them to
 * make a routing table tidier would be a self-inflicted regression on a product
 * that is already in use.
 */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/create": "/post",
  "/dashboard": "/my-jobs",
  // Both freelancer paths now land on the merged page, on the working side.
  "/freelancer": "/my-jobs?tab=working",
  "/work": "/my-jobs?tab=working",
} as const;
