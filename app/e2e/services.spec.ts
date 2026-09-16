import { test, expect, request } from "@playwright/test";

/**
 * THE SERVICES, DIRECTLY.
 *
 * Atelier runs on two backends — the Express API and the Autopilot daemon —
 * and the frontend talks to both. These check each one is actually up and
 * answering the shapes the app encodes against, so a failure here says "the
 * daemon is down" rather than making a UI test lie about why it failed.
 *
 * They are also the only tests that would catch a CORS regression, which is
 * invisible server-side and fatal in a browser.
 */

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:8787";
const DAEMON = process.env.E2E_DAEMON_URL ?? "http://localhost:8080";
const APP_ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:5174";

test.describe("the Express API", () => {
  test("is up", async () => {
    const api = await request.newContext();
    const res = await api.get(`${BACKEND}/health`);
    expect(res.status()).toBe(200);
  });

  /**
   * The API is secret-gated. An endpoint that started answering unauthenticated
   * would be a real security regression, and it is the kind that only shows up
   * when someone checks.
   */
  test("refuses an unauthenticated call rather than serving it", async () => {
    const api = await request.newContext();
    const res = await api.get(`${BACKEND}/v1/analytics`);
    expect(res.status()).toBe(401);
  });
});

test.describe("Patron daemon", () => {
  test("serves the endpoints Atelier reads", async () => {
    const api = await request.newContext();
    for (const path of ["/api/tasks", "/api/decisions", "/api/wallet"]) {
      const res = await api.get(`${DAEMON}${path}`);
      expect(res.status(), `${path}`).toBe(200);
    }
  });

  /**
   * The browser will not let the frontend read a response without these,
   * and the failure is silent in server logs.
   */
  test("allows the app's origin to read its responses", async () => {
    const api = await request.newContext();
    const res = await api.get(`${DAEMON}/api/tasks`, {
      headers: { Origin: APP_ORIGIN },
    });
    const allow = res.headers()["access-control-allow-origin"];
    expect(allow, "daemon must send CORS headers").toBeTruthy();
    expect(allow === "*" || allow === APP_ORIGIN).toBe(true);
  });

  test("reports a usable wallet address", async () => {
    const api = await request.newContext();
    const wallet = await (await api.get(`${DAEMON}/api/wallet`)).json();

    // Atelier appoints THIS address as the on-chain job manager. If it is
    // malformed, setJobManager either reverts or delegates to nowhere.
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  test("returns decisions in the shape the frontend narrows against", async () => {
    const api = await request.newContext();
    const decisions = await (
      await api.get(`${DAEMON}/api/decisions?limit=5`)
    ).json();

    expect(Array.isArray(decisions)).toBe(true);
    if (decisions.length === 0) {
      test.skip(true, "no decisions seeded — run scripts/seed-local-demo.mjs");
    }
    // isDecisionRow in lib/atelier/patron.ts requires exactly these three.
    for (const d of decisions) {
      expect(typeof d.id).toBe("string");
      expect(typeof d.type).toBe("string");
      expect(typeof d.timestamp).toBe("number");
      expect(typeof d.task_id).toBe("string");
    }
  });

  /**
   * The join Atelier does to scope a log to one job. If tasks ever stop
   * carrying escrowId, every per-job decision log silently empties and the app
   * shows manual jobs where Autopilot ones are.
   */
  test("tasks carry the escrow id the decision log joins on", async () => {
    const api = await request.newContext();
    const tasks = await (await api.get(`${DAEMON}/api/tasks`)).json();

    if (tasks.length === 0) {
      test.skip(true, "no tasks seeded — run scripts/seed-local-demo.mjs");
    }
    for (const t of tasks) {
      expect(t).toHaveProperty("escrowId");
      expect(t).toHaveProperty("id");
    }
  });
});
