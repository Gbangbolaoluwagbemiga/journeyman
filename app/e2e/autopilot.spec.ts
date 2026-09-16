import { test, expect } from "@playwright/test";

/**
 * THE AUTOPILOT SURFACES, END TO END.
 *
 * Browser → Vite → Patron daemon → SQLite, with nothing stubbed. These are the
 * tests that fail when the seam breaks rather than when the logic does: a CORS
 * header the daemon stopped sending, a response shape that drifted, a join that
 * silently returns nothing.
 *
 * They need the local daemon running with demo data:
 *   node scripts/seed-local-demo.mjs
 *
 * The seeder defaults to escrow ids 9001/9002. It used to use 1 and 2, which
 * collide with real escrows the moment a contract is redeployed -- a fake task
 * and a genuine job then share an id and the reconciler fights the poller.
 */

test.describe("Post a Job — where the semantic is taught", () => {
  test("presents both modes without calling either one 'AI does the work'", async ({ page }) => {
    await page.goto("/post");

    await expect(page.getByRole("heading", { name: "You run it" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "The agent runs it" })).toBeVisible();

    /*
     * The misreading this page exists to prevent. If the word "freelancer" or
     * "person" ever stops appearing next to Autopilot, someone will conclude the
     * agent does the design work itself — the single worst thing a visitor could
     * take away from this product.
     */
    await expect(page.getByText(/a real person does the work either way/i)).toBeVisible();
  });

  test("promises the same escrow in both modes", async ({ page }) => {
    await page.goto("/post");
    await expect(page.getByText(/either way, the money works the same/i)).toBeVisible();
    await expect(page.getByText(/only you can raise a dispute|dispute/i).first()).toBeVisible();
  });

  test("both columns answer the same questions, so they can be compared", async ({ page }) => {
    await page.goto("/post");
    // The manual card used to omit "Autopilot does" entirely, leaving a hole
    // exactly where the eye tries to read across.
    await expect(page.getByText("Autopilot does")).toHaveCount(2);
    await expect(page.getByText(/nothing\. this one is entirely yours/i)).toBeVisible();
  });

  test("Manual leads to the existing escrow wizard", async ({ page }) => {
    await page.goto("/post");
    await page.getByRole("button", { name: /set up manually/i }).click();
    await expect(page).toHaveURL(/\/create$/);
  });

  test("Autopilot leads to the compose page", async ({ page }) => {
    await page.goto("/post");
    await page.getByRole("button", { name: /hand it to autopilot/i }).click();
    await expect(page).toHaveURL(/\/post\/autopilot$/);
  });
});

test.describe("Autopilot compose", () => {
  /*
   * Composing now requires a connected wallet.
   *
   * The page used to let anyone write an instruction and spend a model call,
   * then stop dead at "Connect a wallet to fund this" -- the dead end was at
   * the bottom of the stairs. Asking first is correct, and it puts the composer
   * itself out of reach of this suite, which drives a browser with no wallet in
   * it. The gate is what is asserted here; the composer tests below are marked
   * fixme rather than deleted, so the missing coverage stays visible until a
   * mock connector is wired up for tests.
   */
  test("asks for a wallet before taking an instruction", async ({ page }) => {
    await page.goto("/post/autopilot");
    await expect(
      page.getByRole("heading", { name: /connect a wallet to post a job/i }),
    ).toBeVisible();
    await expect(page.getByLabel(/what do you need made/i)).toHaveCount(0);
  });

  test.fixme("will not submit an instruction with no budget in it", async ({ page }) => {
    await page.goto("/post/autopilot");

    const submit = page.getByRole("button", { name: /write the brief/i });
    await expect(submit).toBeDisabled();

    await page.getByLabel(/what do you need made/i).fill("A logo for a coffee roastery");
    await expect(submit).toBeDisabled();
    await expect(page.getByText(/add a budget/i)).toBeVisible();

    await page.getByLabel(/what do you need made/i).fill("A logo for a coffee roastery. Budget $50, 3 days.");
    await expect(submit).toBeEnabled();
  });

  test.fixme("promises nothing is funded before the brief is shown", async ({ page }) => {
    await page.goto("/post/autopilot");
    await expect(page.getByText(/nothing is funded at this step/i)).toBeVisible();
  });

  /**
   * Step two, against the real daemon and a real LLM call.
   *
   * This is the screen the whole mode rests on: "the agent writes your brief"
   * is only reassuring if you can read the brief before your money is involved.
   * The test asserts the agent actually produced milestones with amounts, and
   * that the page says plainly who funds the escrow — which is the CLIENT, and
   * is the difference between this and the custodial arrangement the daemon's
   * own /api/instruct still uses.
   */
  test.fixme("shows the agent's proposed brief, with editable milestones", async ({ page }) => {
    test.slow(); // a real generation round trip
    await page.goto("/post/autopilot");

    await page
      .getByLabel(/what do you need made/i)
      .fill("A logo for a coffee roastery. Budget $50, 3 days.");
    await page.getByRole("button", { name: /write the brief/i }).click();

    await expect(page.getByText(/autopilot wrote this/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: /milestones/i })).toBeVisible();

    // Amounts are editable, and the total is derived from them — the contract
    // requires the milestones to sum to the escrow total, so a separately
    // editable budget could be put out of step with them.
    const amounts = page.locator('input[type="number"]');
    expect(await amounts.count()).toBeGreaterThan(2);

    await expect(page.getByText(/you fund this, not autopilot/i)).toBeVisible();

    /*
     * The funding button, whichever state it is in. With no wallet connected it
     * reads "Connect a wallet to fund this"; with one it reads "Fund and post —
     * $75.00". Both are the same control and the test should not care which,
     * only that the page ends in one action rather than handing off to a wizard.
     */
    await expect(
      page.getByRole("button", { name: /fund (and post|this)|connect a wallet to fund/i }),
    ).toBeVisible();

    // The review window is askable now — it was always supported by the daemon
    // and never set by anything.
    await expect(page.getByLabel(/review applications after/i)).toBeVisible();
  });

  test.fixme("can go back and change the instruction without losing the page", async ({ page }) => {
    test.slow();
    await page.goto("/post/autopilot");
    await page
      .getByLabel(/what do you need made/i)
      .fill("A logo for a coffee roastery. Budget $50, 3 days.");
    await page.getByRole("button", { name: /write the brief/i }).click();

    await expect(page.getByText(/autopilot wrote this/i)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /change the instruction/i }).click();

    await expect(page.getByLabel(/what do you need made/i)).toHaveValue(/coffee roastery/i);
  });

  test.fixme("offers example instructions that fill the field", async ({ page }) => {
    await page.goto("/post/autopilot");
    await page.getByRole("button", { name: /a logo for a coffee roastery/i }).click();
    await expect(page.getByLabel(/what do you need made/i)).toHaveValue(/budget \$50/i);
  });
});

test.describe("the decision log, against the live daemon", () => {
  /*
   * Every assertion below is scoped to [data-testid="live-log"].
   *
   * The dev page also renders a hand-written sample log that contains some of
   * the same strings, so an unscoped selector would match it and pass with the
   * daemon switched off — proving nothing about the integration these tests
   * exist for.
   */
  test("reaches the daemon and renders a real job's decisions", async ({ page }) => {
    await page.goto("/dev");
    await page.getByLabel(/escrow id/i).fill("9001");
    const live = page.getByTestId("live-log");

    // 9001 is the clean run from the seeder.
    await expect(live.getByText(/^\d+ decisions$/)).toBeVisible({ timeout: 15_000 });
    await expect(live.getByText("Job posted and escrow funded")).toBeVisible();
    await expect(live.getByText("Freelancer hired")).toBeVisible();

    // The seeder marks its own rows. Their presence proves the text came from
    // SQLite via the daemon rather than from anything compiled into the page.
    await expect(live.getByText(/\[LOCAL DEMO\]/).first()).toBeVisible();
  });

  test("carries the agent's own reasoning through unedited", async ({ page }) => {
    await page.goto("/dev");
    await page.getByLabel(/escrow id/i).fill("9001");
    // Summarising the reasoning would defeat the purpose — the client is
    // checking the agent's thinking, not being reassured about it.
    await expect(
      page
        .getByTestId("live-log")
        .getByText(/answers the stacked-lockup requirement specifically/i),
    ).toBeVisible({ timeout: 15_000 });
  });

  /**
   * The escalation latch, visible. Escrow 2 exhausts its revision rounds and
   * goes to a human; from that point the trail must read teal, and the agent
   * must not appear to take the wheel back.
   */
  test("turns the trail over to a human when a job escalates", async ({ page }) => {
    await page.goto("/dev");
    await page.getByLabel(/escrow id/i).fill("9002");

    const live = page.getByTestId("live-log");
    await expect(live.getByText("Escalated to a human arbiter")).toBeVisible({ timeout: 15_000 });

    // Before the escalation, the agent was acting.
    await expect(live.locator("li", { hasText: "Brief written" })).toHaveClass(/actor-agent/);

    // From the escalation onward, everything is a person's.
    await expect(
      live.locator("li", { hasText: "Escalated to a human arbiter" }),
    ).toHaveClass(/actor-human/);
    await expect(
      live.locator("li", { hasText: "Dispute resolved" }),
    ).toHaveClass(/actor-human/);
  });

  test("marks agent decisions as the agent's", async ({ page }) => {
    await page.goto("/dev");
    await page.getByLabel(/escrow id/i).fill("9001");
    const brief = page.getByTestId("live-log").locator("li", { hasText: "Brief written" });
    await expect(brief).toHaveClass(/actor-agent/, { timeout: 15_000 });
  });

  test("says nothing rather than something false for an unknown escrow", async ({ page }) => {
    await page.goto("/dev");
    await page.getByLabel(/escrow id/i).fill("9001");
    const live = page.getByTestId("live-log");

    // Start from a job that exists, so the empty state below is a real answer
    // from the daemon rather than what this page looks like when nothing loaded.
    // Without this the test passes with the daemon switched off, which is
    // exactly the case it is supposed to distinguish from.
    await expect(live.getByText("Freelancer hired")).toBeVisible({ timeout: 15_000 });

    await page.getByLabel(/escrow id/i).fill("999999");
    await expect(live.getByText("0 decisions")).toBeVisible({ timeout: 15_000 });
    await expect(
      live.getByText(/what a manually-managed job looks like/i),
    ).toBeVisible();
  });

  test("collapses inside a job card, and opens on demand", async ({ page }) => {
    await page.goto("/dev");
    await page.getByLabel(/escrow id/i).fill("9001");

    const toggle = page.getByRole("button", { name: /autopilot activity/i });
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
