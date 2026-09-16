import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { chainableResult, makeSupabaseMock } from "../helpers/supabase-mock.js";
import { applicationsRouter } from "../../src/routes/applications.js";

let supabaseInstance: ReturnType<typeof makeSupabaseMock> | null = null;
vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => supabaseInstance,
}));

const app = express();
app.use(express.json());
app.use("/v1/applications", applicationsRouter);

beforeEach(() => {
  supabaseInstance = makeSupabaseMock({});
});

describe("POST /v1/applications", () => {
  it("requires escrow_id and freelancer_address", async () => {
    const res = await request(app).post("/v1/applications").send({});
    expect(res.status).toBe(400);
  });

  it("stores the application and returns its id", async () => {
    supabaseInstance = makeSupabaseMock({
      from: () => chainableResult({ data: { id: 7 }, error: null }),
    });
    const res = await request(app).post("/v1/applications").send({
      escrow_id: 1,
      freelancer_address: "0xABCDEF0000000000000000000000000000ABCD",
      cover_letter: "I'd love to help",
      proposed_timeline: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 7, success: true });
  });

  it("503s when Supabase isn't configured", async () => {
    supabaseInstance = null;
    const res = await request(app)
      .post("/v1/applications")
      .send({ escrow_id: 1, freelancer_address: "0xabc" });
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/applications/:escrowId", () => {
  it("400s on a non-numeric escrow id", async () => {
    const res = await request(app).get("/v1/applications/not-a-number");
    expect(res.status).toBe(400);
  });

  it("returns applications for a valid escrow id", async () => {
    supabaseInstance = makeSupabaseMock({
      from: () =>
        chainableResult({
          data: [{ id: 1, escrow_id: 1, freelancer_address: "0xabc" }],
          error: null,
        }),
    });
    const res = await request(app).get("/v1/applications/1");
    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
  });

  it("returns an empty list when Supabase isn't configured", async () => {
    supabaseInstance = null;
    const res = await request(app).get("/v1/applications/1");
    expect(res.status).toBe(200);
    expect(res.body.applications).toEqual([]);
  });
});
