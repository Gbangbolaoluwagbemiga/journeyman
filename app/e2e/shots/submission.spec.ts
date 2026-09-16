import { test } from "@playwright/test";

/**
 * THE SUBMISSION SCREENSHOTS.
 *
 * Not tests — a harness for the five images that carry the story on a judging
 * page, taken against the real local stack so the data in them is real. Run it
 * with all three services up:
 *
 *   SHOT_DIR=../submission-shots npx playwright test e2e/shots/submission.spec.ts --grep @shot
 *
 * Ordered as a judge would read them: what the marketplace is, who the client
 * can be, what the agent decided, what the freelancer sees, and what happens
 * when the two of them disagree.
 */

const DIR = process.env.SHOT_DIR ?? "submission-shots";

/* The real managed worker on this machine. Seeding the session rather than
   automating Google means these shots carry actual on-chain history — a
   finished job, an arbiter's split — instead of an empty demo account. */
const WORKER_ID = process.env.SHOT_WORKER_ID ?? "8d54ff76-b70f-433b-af9f-857fedf84179";
const WORKER_ADDRESS =
  process.env.SHOT_WORKER_ADDRESS ?? "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";

/** 16:9 at retina, which is what a judging card wants. */
const WIDE = { width: 1440, height: 810 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([id, addr]) => {
      try {
        localStorage.setItem("atelier:worker-id", id);
        localStorage.setItem("atelier.worker.address", addr);
      } catch {
        /* private mode — the shot just renders signed out */
      }
    },
    [WORKER_ID, WORKER_ADDRESS],
  );
});

/**
 * The sign-in email, swapped for a placeholder.
 *
 * The board prints "Signed in as <email>" on purpose — two Google accounts can
 * carry the same handle, and when they do the page is otherwise identical apart
 * from a truncated hex address, so signing in with the wrong one looks exactly
 * like the app losing the job the other one was hired for.
 *
 * That is right for the product and wrong for a public judging page, where it
 * would publish a personal address next to the project. This swaps the text for
 * a demo one. It changes no behaviour and makes no claim — it is the same
 * screen a different account would render — and it is done here rather than by
 * cropping so the shot keeps the line that explains why the screen has it.
 */
const DEMO_EMAIL = "cdev@atelier.demo";

async function redactEmail(page: import("@playwright/test").Page) {
  await page.evaluate((demo) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const re = /[\w.+-]+@[\w-]+\.[\w.]+/g;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue && re.test(n.nodeValue)) {
        n.nodeValue = n.nodeValue.replace(re, demo);
      }
    }
  }, DEMO_EMAIL);
}

/** Let the board's polls land before freezing the frame. */
async function settle(page: import("@playwright/test").Page, ms = 4000) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
  await redactEmail(page);
}

test("@shot 1 the job board", async ({ page }) => {
  test.slow();
  await page.setViewportSize(WIDE);
  await page.goto("/jobs");
  await settle(page);
  await page.screenshot({ path: `${DIR}/1-job-board.png` });
});

test("@shot 2 posting on autopilot", async ({ page }) => {
  test.slow();
  await page.setViewportSize(WIDE);
  await page.goto("/post/autopilot");
  await settle(page, 2000);
  await page.screenshot({ path: `${DIR}/2-post-autopilot.png` });
});

test("@shot 3 the freelancer board", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/get-hired");
  await settle(page, 6000);
  await page.screenshot({ path: `${DIR}/3-freelancer-board.png`, fullPage: true });
});

test("@shot 4 the decision log", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/my-jobs");
  await settle(page, 6000);
  await page.screenshot({ path: `${DIR}/4-my-jobs.png`, fullPage: true });
});

test("@shot 5 analytics", async ({ page }) => {
  test.slow();
  await page.setViewportSize(WIDE);
  await page.goto("/analytics");
  await settle(page, 5000);
  await page.screenshot({ path: `${DIR}/5-analytics.png` });
});
