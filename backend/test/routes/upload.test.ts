import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import { makeSupabaseMock } from "../helpers/supabase-mock.js";

// Deterministic, non-funded test-only private keys — never used on any real
// network, just local signature generation/verification.
const depositor = privateKeyToAccount(`0x${"1".repeat(64)}` as `0x${string}`);
const beneficiary = privateKeyToAccount(`0x${"2".repeat(64)}` as `0x${string}`);
const stranger = privateKeyToAccount(`0x${"3".repeat(64)}` as `0x${string}`);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const readContractMock = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract: readContractMock }),
  };
});

let supabaseInstance: ReturnType<typeof makeSupabaseMock> | null = null;
vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => supabaseInstance,
}));

function baseEscrow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    depositor: depositor.address,
    beneficiary: ZERO_ADDRESS,
    token: ZERO_ADDRESS,
    totalAmount: 100n,
    paidAmount: 0n,
    deadline: 0n,
    status: 0,
    workStarted: false,
    platformFee: 0n,
    arbiters: [],
    requiredConfirmations: 0n,
    isOpenJob: true,
    projectTitle: "Test job",
    projectDescription: "",
    ...overrides,
  };
}

// Module under test reads process.env.CONTRACT_ADDRESS at import time, so it
// must be imported dynamically *after* the env var is set.
let uploadRouter: typeof import("../../src/routes/upload.js")["uploadRouter"];
let buildUploadAuthMessage: typeof import("../../src/routes/upload.js")["buildUploadAuthMessage"];
let app: express.Express;

beforeAll(async () => {
  process.env.CONTRACT_ADDRESS = "0x000000000000000000000000000000000000aa";
  process.env.ARC_RPC_URL = "http://127.0.0.1:1"; // never actually dialed — readContract is mocked
  const mod = await import("../../src/routes/upload.js");
  uploadRouter = mod.uploadRouter;
  buildUploadAuthMessage = mod.buildUploadAuthMessage;

  app = express();
  app.use("/v1/upload", uploadRouter);
});

beforeEach(() => {
  supabaseInstance = makeSupabaseMock({});
  readContractMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function signUpload(
  account: typeof depositor,
  escrowId: string,
  milestoneIndex: string,
  walletAddress: string,
  timestamp: number,
) {
  const message = buildUploadAuthMessage(escrowId, milestoneIndex, walletAddress, String(timestamp));
  return account.signMessage({ message });
}

function attachValidFile(req: request.Test) {
  return req.attach("file", Buffer.from("hello world"), {
    filename: "proof.txt",
    contentType: "text/plain",
  });
}

describe("POST /v1/upload/milestone — input validation", () => {
  it("rejects a non-numeric escrow_id", async () => {
    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", "not-a-number")
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address)
        .field("signature", "0xdead")
        .field("timestamp", String(Date.now())),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/numeric escrow ID/i);
  });

  it("rejects a malformed wallet_address", async () => {
    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", "1")
        .field("milestone_index", "0")
        .field("wallet_address", "not-an-address")
        .field("signature", "0xdead")
        .field("timestamp", String(Date.now())),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid Arc EVM address/i);
  });

  it("rejects a request missing signature/timestamp", async () => {
    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", "1")
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature and timestamp/i);
  });

  it("rejects when no file is attached", async () => {
    const res = await request(app)
      .post("/v1/upload/milestone")
      .field("escrow_id", "1")
      .field("milestone_index", "0")
      .field("wallet_address", depositor.address)
      .field("signature", "0xdead")
      .field("timestamp", String(Date.now()));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No file provided/i);
  });
});

describe("POST /v1/upload/milestone — signature verification", () => {
  it("rejects an expired timestamp (> 5 minutes old)", async () => {
    const escrowId = "1";
    const milestoneIndex = "0";
    const staleTimestamp = Date.now() - 6 * 60 * 1000;
    const signature = await signUpload(depositor, escrowId, milestoneIndex, depositor.address, staleTimestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", milestoneIndex)
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(staleTimestamp)),
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("rejects a signature that doesn't match the claimed wallet_address", async () => {
    const escrowId = "1";
    const milestoneIndex = "0";
    const timestamp = Date.now();
    // Signed by `stranger` but claims to be `depositor` — must be rejected.
    const signature = await signUpload(stranger, escrowId, milestoneIndex, depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", milestoneIndex)
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid upload signature/i);
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("rejects a signature for a different escrow/milestone than claimed", async () => {
    const timestamp = Date.now();
    // Sign for escrow 2, but submit the request claiming escrow 1.
    const signature = await signUpload(depositor, "2", "0", depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", "1")
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid upload signature/i);
  });
});

describe("POST /v1/upload/milestone — on-chain ownership check", () => {
  it("rejects a stranger uploading to an ASSIGNED escrow they have no part in", async () => {
    readContractMock.mockResolvedValueOnce(
      baseEscrow({ beneficiary: beneficiary.address, isOpenJob: false }),
    );
    const escrowId = "1";
    const timestamp = Date.now();
    const signature = await signUpload(stranger, escrowId, "0", stranger.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", stranger.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a party to this escrow/i);
  });

  it("allows the depositor to upload to their own ASSIGNED escrow", async () => {
    readContractMock.mockResolvedValueOnce(
      baseEscrow({ beneficiary: beneficiary.address, isOpenJob: false }),
    );
    const escrowId = "1";
    const timestamp = Date.now();
    const signature = await signUpload(depositor, escrowId, "0", depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(201);
    expect(res.body.url).toBeTruthy();
  });

  it("allows the assigned beneficiary (freelancer) to upload to their own escrow", async () => {
    readContractMock.mockResolvedValueOnce(
      baseEscrow({ beneficiary: beneficiary.address, isOpenJob: false }),
    );
    const escrowId = "1";
    const timestamp = Date.now();
    const signature = await signUpload(beneficiary, escrowId, "0", beneficiary.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", beneficiary.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(201);
  });

  it("allows ANY signed wallet to upload to a still-OPEN (unassigned) job — applicants aren't parties yet", async () => {
    readContractMock.mockResolvedValueOnce(baseEscrow({ beneficiary: ZERO_ADDRESS, isOpenJob: true }));
    const escrowId = "1";
    const timestamp = Date.now();
    const signature = await signUpload(stranger, escrowId, "0", stranger.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", stranger.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(201);
  });

  it("returns 400 when the escrow can't be read on-chain (bad escrow_id)", async () => {
    readContractMock.mockRejectedValueOnce(new Error("execution reverted"));
    const escrowId = "999999";
    const timestamp = Date.now();
    const signature = await signUpload(depositor, escrowId, "0", depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Could not verify escrow/i);
  });
});

describe("POST /v1/upload/milestone — storage layer", () => {
  it("returns 503 when Supabase isn't configured", async () => {
    supabaseInstance = null;
    const escrowId = "1";
    const timestamp = Date.now();
    const signature = await signUpload(depositor, escrowId, "0", depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(503);
  });

  it("surfaces a helpful hint when Supabase storage rejects for RLS reasons", async () => {
    readContractMock.mockResolvedValueOnce(baseEscrow({ beneficiary: ZERO_ADDRESS }));
    supabaseInstance = makeSupabaseMock({
      storage: {
        upload: vi.fn(async () => ({ error: { message: "new row violates row-level security policy" } })),
      },
    });
    const escrowId = "1";
    const timestamp = Date.now();
    const signature = await signUpload(depositor, escrowId, "0", depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "0")
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/row-level security/i);
  });

  it("returns the public URL on a successful upload", async () => {
    readContractMock.mockResolvedValueOnce(baseEscrow({ beneficiary: ZERO_ADDRESS }));
    const escrowId = "42";
    const timestamp = Date.now();
    const signature = await signUpload(depositor, escrowId, "3", depositor.address, timestamp);

    const res = await attachValidFile(
      request(app)
        .post("/v1/upload/milestone")
        .field("escrow_id", escrowId)
        .field("milestone_index", "3")
        .field("wallet_address", depositor.address)
        .field("signature", signature)
        .field("timestamp", String(timestamp)),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filename: "proof.txt",
      mimeType: "text/plain",
    });
    expect(res.body.url).toContain(`${escrowId}/3/`);
  });
});
