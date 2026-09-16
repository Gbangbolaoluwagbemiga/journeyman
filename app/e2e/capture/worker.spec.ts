import { test } from "@playwright/test";
test("@shot get hired", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1250 });
  await page.goto("/get-hired");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: process.env.SHOT_DIR + "/get-hired.png", fullPage: true });
});
