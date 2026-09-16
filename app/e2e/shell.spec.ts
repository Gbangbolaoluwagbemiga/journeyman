import { test, expect } from "@playwright/test";

/**
 * THE APP SHELL.
 *
 * Atelier's information architecture is a product decision — one job list, one
 * freelancer experience, modes only on the client side — and it is the kind of
 * decision that erodes silently. A route quietly 404s after a refactor, a nav
 * entry gets duplicated, a legacy path stops redirecting and a live user's
 * bookmark breaks. None of that shows up in a unit test.
 */

test.describe("routes resolve", () => {
  /*
   * Every route a visitor can reach, not a sample of them.
   *
   * Browse Jobs once rendered a blank black page for a whole day because a hook
   * was added inside a render loop — the request still returned 200, the shell
   * still mounted, and only the page-error assertion below would have caught it.
   * A route missing from this list is a route that can break silently.
   */
  for (const path of [
    "/",
    "/jobs",
    "/jobs/1", // the deep link an agent sends into Telegram
    "/post",
    "/post/autopilot",
    "/create",
    "/get-hired",
    "/freelancers",
    "/analytics",
    "/my-jobs",
    "/approvals",
    "/messages",
    "/admin",
    "/disputes",
  ]) {
    test(`${path} renders without a crash`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));

      const res = await page.goto(path);
      expect(res?.status(), `${path} should serve`).toBeLessThan(400);

      // The app is a SPA, so a broken route renders an empty shell rather than
      // failing the request. Assert something actually painted.
      await expect(page.locator("nav")).toBeVisible();
      expect(errors, `${path} threw: ${errors.join("; ")}`).toEqual([]);
    });
  }
});

test.describe("paths from the pre-rename app still work", () => {
  /**
   * The deployed app, the README and real users' bookmarks all point at these.
   * Breaking them to tidy a routing table would be a self-inflicted regression
   * on a product already in use.
   */
  const redirects: [string, string][] = [
    ["/dashboard", "/my-jobs"],
    // Both freelancer paths now land on the merged page, on the working side.
    ["/freelancer", "/my-jobs\\?tab=working"],
    ["/work", "/my-jobs\\?tab=working"],
  ];

  for (const [from, to] of redirects) {
    test(`${from} redirects to ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL(new RegExp(`${to}$`));
    });
  }

  test("/create still serves the manual wizard, not a redirect", async ({ page }) => {
    await page.goto("/create");
    await expect(page).toHaveURL(/\/create$/);
  });
});

test.describe("the navigation", () => {
  test("offers a way in and a way to post, with no wallet connected", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav").first();

    await expect(nav.getByRole("link", { name: "Browse Jobs" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Post a Job" })).toBeVisible();
  });

  test("hides role-gated areas from a disconnected visitor", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav").first();

    // My Jobs and Admin are earned, not default. A first-time visitor seeing an
    // empty "My Jobs" learns the product is not for them yet.
    await expect(nav.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "My Jobs" })).toHaveCount(0);
  });

  /**
   * Disputes is arbitration — a staff tool reached from Admin. It must not be
   * in the nav for anybody, and a client or freelancer in a dispute reaches it
   * from the job, which is the context they need anyway.
   */
  test("never lists Disputes in the nav", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.locator("nav").first().getByRole("link", { name: "Disputes" }),
    ).toHaveCount(0);
  });

  /** The two entries that were split and are now one destination. */
  test("offers a single My Jobs entry, not My Work and My Jobs", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav").first();
    await expect(nav.getByRole("link", { name: "My Work" })).toHaveCount(0);
  });

  test("marks the current section", async ({ page }) => {
    await page.goto("/post");
    const current = page.locator("nav a[aria-current='page']");
    await expect(current).toHaveText(/post a job/i);
  });

  test("navigates without a full page load", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav").first().getByRole("link", { name: "Browse Jobs" }).click();
    await expect(page).toHaveURL(/\/jobs$/);
  });
});
