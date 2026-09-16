import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

/**
 * WHICH BROWSERS ARE ALLOWED TO TALK TO THIS API.
 *
 * A missing FRONTEND_URL entry took the deployed web app off the API entirely
 * — every notification, message, application and upload blocked — and the only
 * symptom was a 500 on an OPTIONS request. That is the worst possible signal:
 * a 500 sends whoever is debugging to the server logs, when the fault is one
 * line of configuration.
 *
 * So the rule here is not only "the right origins are allowed". It is that a
 * refusal says it is a refusal, names the origin, and says where to fix it.
 */

const ALLOWED = "https://atelier-job.vercel.app";
const PREVIEW = "https://atelier-job-git-feature.vercel.app";
const STRANGER = "https://not-ours.example.com";

async function appWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("../../src/index.js")).default;
}

const saved = { ...process.env };
beforeEach(() => { process.env.VERCEL = "1"; }); // stop index.ts calling listen()
afterEach(() => { process.env = { ...saved }; });

describe("with an allow-list configured", () => {
  it("lets the deployed web app through", async () => {
    const app = await appWith({ FRONTEND_URL: ALLOWED, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app).get("/health").set("Origin", ALLOWED);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  /* The failure that actually happened: the live origin was simply not listed. */
  it("refuses an origin that is not listed, and says so", async () => {
    const app = await appWith({ FRONTEND_URL: ALLOWED, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app).get("/health").set("Origin", STRANGER);
    expect(res.status).toBe(403);
    expect(res.body.origin).toBe(STRANGER);
    expect(res.body.hint).toMatch(/FRONTEND_URL/);
  });

  /* A 500 on a preflight reads as "the API is broken" and sends the next
     person to the server logs instead of to the environment variables. */
  it("does not answer a refused preflight with a 500", async () => {
    const app = await appWith({ FRONTEND_URL: ALLOWED, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app)
      .options("/v1/notifications")
      .set("Origin", STRANGER)
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).not.toBe(500);
  });

  it("takes several origins, comma-separated", async () => {
    const app = await appWith({
      FRONTEND_URL: `${ALLOWED},http://localhost:5173`,
      FRONTEND_URL_PATTERN: undefined,
    });
    const res = await request(app).get("/health").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  /* Vercel gives every branch its own hostname, so an exact list alone means
     no preview deployment can ever reach the API. */
  it("allows preview deployments through the pattern", async () => {
    const app = await appWith({
      FRONTEND_URL: ALLOWED,
      FRONTEND_URL_PATTERN: "^https://atelier-job.*\\.vercel\\.app$",
    });
    const res = await request(app).get("/health").set("Origin", PREVIEW);
    expect(res.headers["access-control-allow-origin"]).toBe(PREVIEW);
  });

  it("still refuses a stranger that the pattern does not match", async () => {
    const app = await appWith({
      FRONTEND_URL: ALLOWED,
      FRONTEND_URL_PATTERN: "^https://atelier-job.*\\.vercel\\.app$",
    });
    const res = await request(app).get("/health").set("Origin", STRANGER);
    expect(res.status).toBe(403);
  });
});

/**
 * curl, the daemon, another server — none of these send an Origin, and none of
 * them are what CORS protects against. Blocking them would take down the agent.
 */
describe("requests with no browser origin", () => {
  it("are always allowed", async () => {
    const app = await appWith({ FRONTEND_URL: ALLOWED, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("with nothing configured", () => {
  it("allows everything, so local development is not a puzzle", async () => {
    const app = await appWith({ FRONTEND_URL: undefined, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app).get("/health").set("Origin", STRANGER);
    expect(res.status).toBe(200);
  });
});

/**
 * The README links the API's root, and a JSON service with no page answered a
 * 404 there — so anyone following that link met an error and had to guess
 * whether the service was down.
 */
describe("the root", () => {
  it("says what this service is", async () => {
    const app = await appWith({ FRONTEND_URL: undefined, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("Atelier API");
  });

  it("points at the endpoints worth knowing", async () => {
    const app = await appWith({ FRONTEND_URL: undefined, FRONTEND_URL_PATTERN: undefined });
    const res = await request(app).get("/");
    expect(res.body.endpoints.health).toBe("/health");
    expect(Object.keys(res.body.endpoints).length).toBeGreaterThan(3);
  });

  /*
   * It must not leak the values it names.
   *
   * Naming API_SECRET as the header to send is the point of a signpost; putting
   * its value in the response would not be. The first version of this test
   * matched the word rather than the value and failed on its own hint, which is
   * the difference worth encoding.
   */
  it("names the secret without printing it", async () => {
    const app = await appWith({
      FRONTEND_URL: undefined,
      FRONTEND_URL_PATTERN: undefined,
      API_SECRET: "s3cret-value-not-for-publication",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_should_never_appear",
    });
    const res = await request(app).get("/");
    const body = JSON.stringify(res.body);

    expect(body).toContain("API_SECRET");
    expect(body).not.toContain("s3cret-value-not-for-publication");
    expect(body).not.toContain("sb_secret_should_never_appear");
  });
});
