import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { chainableResult, makeSupabaseMock } from "../helpers/supabase-mock.js";
import { notificationsRouter } from "../../src/routes/notifications.js";

let supabaseInstance: ReturnType<typeof makeSupabaseMock> | null = null;
vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => supabaseInstance,
}));

const app = express();
app.use(express.json());
app.use("/v1/notifications", notificationsRouter);

const VALID_WALLET = "0x1111111111111111111111111111111111111111";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  supabaseInstance = makeSupabaseMock({});
});

describe("GET /v1/notifications", () => {
  it("400s without a wallet query param", async () => {
    const res = await request(app).get("/v1/notifications");
    expect(res.status).toBe(400);
  });

  it("400s on a malformed wallet address", async () => {
    const res = await request(app).get("/v1/notifications?wallet=not-an-address");
    expect(res.status).toBe(400);
  });

  it("returns the mapped notification list for a valid wallet", async () => {
    const row = {
      id: VALID_UUID,
      wallet_address: VALID_WALLET,
      type: "application",
      title: "Job Cancelled",
      message: "The client cancelled the job.",
      read_at: null,
      action_url: "/browse-jobs",
      data: { action: "job_cancelled" },
      created_at: "2026-08-01T00:00:00.000Z",
    };
    supabaseInstance = makeSupabaseMock({
      from: () => chainableResult({ data: [row], error: null }),
    });

    const res = await request(app).get(`/v1/notifications?wallet=${VALID_WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({
      id: VALID_UUID,
      title: "Job Cancelled",
      read: false,
    });
  });

  it("returns an empty list when Supabase isn't configured, instead of erroring", async () => {
    supabaseInstance = null;
    const res = await request(app).get(`/v1/notifications?wallet=${VALID_WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
  });
});

describe("PATCH /v1/notifications/:id/read", () => {
  it("400s on a non-UUID notification id", async () => {
    const res = await request(app)
      .patch(`/v1/notifications/not-a-uuid/read?wallet=${VALID_WALLET}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("400s on a malformed wallet", async () => {
    const res = await request(app)
      .patch(`/v1/notifications/${VALID_UUID}/read?wallet=bad`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("marks a notification read for a valid id + wallet", async () => {
    const res = await request(app)
      .patch(`/v1/notifications/${VALID_UUID}/read?wallet=${VALID_WALLET}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("POST /v1/notifications", () => {
  it("400s without wallet_address", async () => {
    const res = await request(app)
      .post("/v1/notifications")
      .send({ type: "application", title: "t", message: "m" });
    expect(res.status).toBe(400);
  });

  it("400s when type/title/message are missing", async () => {
    const res = await request(app)
      .post("/v1/notifications")
      .send({ wallet_address: VALID_WALLET });
    expect(res.status).toBe(400);
  });

  it("creates a notification and returns its id", async () => {
    supabaseInstance = makeSupabaseMock({
      from: () => chainableResult({ data: { id: VALID_UUID }, error: null }),
    });
    const res = await request(app).post("/v1/notifications").send({
      wallet_address: VALID_WALLET,
      type: "application",
      title: "Job Cancelled",
      message: "The client cancelled the job.",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: VALID_UUID });
  });

  it("503s when Supabase isn't configured", async () => {
    supabaseInstance = null;
    const res = await request(app).post("/v1/notifications").send({
      wallet_address: VALID_WALLET,
      type: "application",
      title: "t",
      message: "m",
    });
    expect(res.status).toBe(503);
  });
});
