import { defineConfig, devices } from "@playwright/test";

/**
 * THE SCREENSHOT HARNESS, kept out of the test suite on purpose.
 *
 * `playwright.config.ts` ignores `shots/` and `capture/` because these are not
 * tests — they assert nothing, they cost an LLM round trip, and counting them
 * would quietly inflate the figure the README quotes. They need their own
 * config rather than a flag, because Playwright has no CLI override for
 * testIgnore.
 *
 *   (cd app && SHOT_DIR=../submission-shots \
 *      npx playwright test -c playwright.shots.config.ts)
 *
 * Needs all three services up — these are pictures of real data, which is the
 * only reason to take them this way instead of cropping a desktop capture.
 */
export default defineConfig({
  testDir: "./e2e/shots",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  /* Generous: these wait for chain reads on a public RPC that rate-limits. */
  timeout: 180_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    screenshot: "off",
    trace: "off",
  },
  /* deviceScaleFactor belongs INSIDE the project: `devices["Desktop Chrome"]`
     carries its own (1), and a project's `use` wins over the top-level one, so
     setting it above produced 1x images while claiming to produce retina. */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], deviceScaleFactor: 2 },
    },
  ],
});
