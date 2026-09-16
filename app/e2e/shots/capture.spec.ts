import { test } from "@playwright/test";

/** Not a test — a screenshot harness. Run with `--grep @shot`. */
test("@shot brief review", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.goto("/post/autopilot");
  await page.getByLabel(/what do you need made/i).fill("A logo for a coffee roastery. Budget $50, 3 days.");
  await page.getByRole("button", { name: /write the brief/i }).click();
  await page.getByText(/autopilot wrote this/i).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: process.env.SHOT_DIR + "/brief-review.png", fullPage: true });
});
