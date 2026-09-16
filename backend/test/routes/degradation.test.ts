import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { chainableThrows, makeSupabaseMock } from "../helpers/supabase-mock.js";

/**
 * WHAT THE APP DOES WHEN THE DATABASE HAS GONE AWAY.
 *
 * Every route already handled "no store configured". None of them handled
 * "store configured, host no longer resolves" — the Supabase client throws
 * before it can resolve `{ data, error }`, and with no catch that reached the
 * browser as `TypeError: fetch failed`, HTTP 500, on every page load. A dead
 * notifications table took the whole app down with it.
 *
 * The rule these tests hold to:
 *
 *   a read degrades — an empty bell is honest, the page still works
 *   a write does not — telling someone their message sent when it did not
 *   is worse than telling them it failed
 *
 * The `degraded: true` flag exists so a caller can tell "you have no
 * notifications" from "we cannot currently see your notifications".
 */

let supabaseInstance: any = null;
vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => supabaseInstance,
}));

const { notificationsRouter } = await import("../../src/routes/notifications.js");
const { messagesRouter } = await import("../../src/routes/messages.js");
const { applicationsRouter } = await import("../../src/routes/applications.js");

const app = express();
app.use(express.json());
app.use("/v1/notifications", notificationsRouter);
app.use("/v1/messages", messagesRouter);
app.use("/v1/applications", applicationsRouter);

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const UUID = "550e8400-e29b-41d4-a716-446655440000";

/** Configured, and every query throws — exactly what a dead project looks like. */
beforeEach(() => {
  supabaseInstance = makeSupabaseMock({ from: () => chainableThrows() });
});

describe("reads keep working, emptily", () => {
  it("shows an empty bell instead of 500ing the page", async () => {
    const res = await request(app).get(`/v1/notifications?wallet=${A}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.degraded).toBe(true);
  });

  it("returns an empty conversation rather than an error", async () => {
    const res = await request(app).get(`/v1/messages/conversation?a=${A}&b=${B}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.degraded).toBe(true);
  });

  it("returns an empty inbox", async () => {
    const res = await request(app).get(`/v1/messages/inbox?wallet=${A}`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([]);
  });

  /* This one is polled on a timer, so a 500 here is a 500 every few seconds. */
  it("reports zero unread rather than failing the badge", async () => {
    const res = await request(app).get(`/v1/messages/unread-count?wallet=${A}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it("returns no applications for a job rather than breaking the job page", async () => {
    const res = await request(app).get("/v1/applications/4");
    expect(res.status).toBe(200);
    expect(res.body.applications).toEqual([]);
  });
});

describe("writes admit they failed", () => {
  it("does not pretend a message was sent", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .send({ sender_address: A, recipient_address: B, content: "hello" });
    expect(res.status).toBe(503);
    expect(res.body.id).toBeUndefined();
  });

  it("does not pretend a notification was stored", async () => {
    const res = await request(app)
      .post("/v1/notifications")
      .send({ wallet_address: A, type: "application", title: "t", message: "m" });
    expect(res.status).toBe(503);
  });

  it("does not pretend an application was recorded", async () => {
    const res = await request(app)
      .post("/v1/applications")
      .send({ escrow_id: 4, freelancer_address: A });
    expect(res.status).toBe(503);
    expect(res.body.success).toBeUndefined();
  });

  it("does not pretend a notification was marked read", async () => {
    const res = await request(app).patch(`/v1/notifications/${UUID}/read?wallet=${A}`);
    expect(res.status).toBe(503);
  });

  it("does not pretend a thread was marked read", async () => {
    const res = await request(app).patch(
      `/v1/messages/conversation/read?a=${A}&b=${B}&wallet=${A}`,
    );
    expect(res.status).toBe(503);
  });
});

/**
 * A store that answers "no" is a different problem from one that never answers,
 * and conflating them would send whoever is on call looking at DNS when the
 * actual fault is a policy we wrote.
 */
describe("a refusal is not an outage", () => {
  it("still 500s when the store answers with an error", async () => {
    const { chainableResult } = await import("../helpers/supabase-mock.js");
    supabaseInstance = makeSupabaseMock({
      from: () =>
        chainableResult({ data: null, error: { message: "violates row-level security" } }),
    });

    const res = await request(app)
      .post("/v1/notifications")
      .send({ wallet_address: A, type: "application", title: "t", message: "m" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/row-level security/i);
  });
});
