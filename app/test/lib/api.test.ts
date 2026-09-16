import { beforeEach, describe, expect, it, vi } from "vitest";

// The frontend (src/lib/api.ts) and backend (backend/src/routes/upload.ts)
// each keep their own copy of buildUploadAuthMessage — they're separate
// packages so it can't be a shared import. If either one drifts, uploads
// break with "Invalid upload signature". This test imports both real
// implementations and asserts they're byte-identical for the same inputs.
describe("buildUploadAuthMessage — frontend/backend parity", () => {
  it("produces byte-identical output on both sides", async () => {
    const frontend = await import("@/lib/api");
    const backend = await import("../../../backend/src/routes/upload.ts");

    const cases: Array<[string | number, number, string, number]> = [
      [1, 0, "0xABCDEF0000000000000000000000000000abcd", 1_700_000_000_000],
      [42, 3, "0x0000000000000000000000000000000000dead", 1],
      ["999", 12, "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", 0],
    ];

    for (const [escrowId, milestoneIndex, wallet, timestamp] of cases) {
      const fromFrontend = frontend.buildUploadAuthMessage(escrowId, milestoneIndex, wallet, timestamp);
      const fromBackend = backend.buildUploadAuthMessage(
        String(escrowId),
        String(milestoneIndex),
        wallet,
        String(timestamp),
      );
      expect(fromFrontend).toBe(fromBackend);
    }
  });
});

describe("uploadMilestoneFile", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ url: "https://cdn.example.test/f.txt", filename: "f.txt", size: 3, mimeType: "text/plain" }),
      })),
    );
  });

  it("signs the exact auth message before uploading, and includes it in the form data", async () => {
    const { uploadMilestoneFile, buildUploadAuthMessage } = await import("@/lib/api");
    const signMessageAsync = vi.fn(async ({ message }: { message: string }) => `signed:${message.length}`);
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await uploadMilestoneFile(file, 7, 2, "0xABCDEF0000000000000000000000000000abcd", signMessageAsync);
    nowSpy.mockRestore();

    expect(signMessageAsync).toHaveBeenCalledTimes(1);
    const signedMessage = signMessageAsync.mock.calls[0][0].message;
    expect(signedMessage).toBe(
      buildUploadAuthMessage(7, 2, "0xABCDEF0000000000000000000000000000abcd", 1_800_000_000_000),
    );

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/upload/milestone");
    const form = init.body as FormData;
    expect(form.get("escrow_id")).toBe("7");
    expect(form.get("milestone_index")).toBe("2");
    expect(form.get("wallet_address")).toBe("0xABCDEF0000000000000000000000000000abcd");
    expect(form.get("timestamp")).toBe("1800000000000");
    expect(form.get("signature")).toBe(`signed:${signedMessage.length}`);
  });

  it("throws with the server's error message on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        statusText: "Forbidden",
        text: async () => JSON.stringify({ error: "You are not a party to this escrow" }),
      })),
    );
    const { uploadMilestoneFile } = await import("@/lib/api");
    const signMessageAsync = vi.fn(async () => "0xsig");
    const file = new File(["x"], "x.txt", { type: "text/plain" });

    await expect(
      uploadMilestoneFile(file, 1, 0, "0xABCDEF0000000000000000000000000000abcd", signMessageAsync),
    ).rejects.toThrow("You are not a party to this escrow");
  });
});
