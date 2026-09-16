import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { makeSupabaseMock } from "../helpers/supabase-mock.js";
import { messagesRouter } from "../../src/routes/messages.js";

/**
 * ONE ADDRESS, ONE SPELLING.
 *
 * A client opened Browse Freelancers, where addresses come off the chain
 * checksummed, and sent a direct message to 0x8289…C423. That freelancer's
 * session asked for its inbox with 0x8289…c423 — the lowercase address the
 * daemon issued their managed wallet. Every comparison in this router was raw
 * string equality, so the two spellings never met.
 *
 * The message was in the table, correctly addressed, and invisible: not in the
 * thread, not in the inbox, not in the unread count, so nothing rang either.
 * From the freelancer's side the product had simply not delivered it.
 */

let supabaseInstance: ReturnType<typeof makeSupabaseMock> | null = null;
vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => supabaseInstance,
}));

const app = express();
app.use(express.json());
app.use("/v1/messages", messagesRouter);

/** The same two people, spelled both ways. */
const FREELANCER_LOWER = "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423";
const FREELANCER_CHECKSUMMED = "0x8289DA3F656FB9AFB94E1074C7E88F0AD98AC423";
const CLIENT_CHECKSUMMED = "0x3Be7000000000000000000000000000000008E41";
const CLIENT_LOWER = CLIENT_CHECKSUMMED.toLowerCase();

/** A query builder that remembers what it was asked, so filters can be asserted. */
function recordingBuilder(result: { data: unknown; error: unknown; count?: number }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        if (prop === "__calls") return calls;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

/** Every argument the builder was handed, flattened to strings. */
const argsOf = (b: any): string =>
  (b.__calls as { args: unknown[] }[])
    .flatMap((c) => c.args.map((a) => String(a)))
    .join(" | ");

let builder: any;

beforeEach(() => {
  builder = recordingBuilder({ data: [], error: null, count: 0 });
  supabaseInstance = makeSupabaseMock({ from: () => builder });
});

describe("sending a message", () => {
  it("stores both addresses folded to one spelling", async () => {
    builder = recordingBuilder({ data: { id: "m1", created_at: "2026-09-11T22:18:00Z" }, error: null });
    supabaseInstance = makeSupabaseMock({ from: () => builder });

    const res = await request(app).post("/v1/messages").send({
      sender_address: CLIENT_CHECKSUMMED,
      recipient_address: FREELANCER_CHECKSUMMED,
      content: "Hey",
    });

    expect(res.status).toBe(201);
    const insert = (builder.__calls as { method: string; args: any[] }[])
      .find((c) => c.method === "insert")!.args[0];
    expect(insert.sender_address).toBe(CLIENT_LOWER);
    expect(insert.recipient_address).toBe(FREELANCER_LOWER);
    // Sorted and folded, so both sides derive the same thread id.
    expect(insert.conversation_id).toBe([CLIENT_LOWER, FREELANCER_LOWER].sort().join(":"));
  });

  it("still refuses a message to yourself in the other spelling", async () => {
    const res = await request(app).post("/v1/messages").send({
      sender_address: FREELANCER_CHECKSUMMED,
      recipient_address: FREELANCER_LOWER,
      content: "note to self",
    });
    expect(res.status).toBe(400);
  });
});

describe("reading a thread", () => {
  it("finds it however either side spelled the addresses", async () => {
    const res = await request(app).get(
      `/v1/messages/conversation?a=${FREELANCER_LOWER}&b=${CLIENT_CHECKSUMMED}`,
    );

    expect(res.status).toBe(200);
    const asked = argsOf(builder);
    expect(asked).toContain(FREELANCER_LOWER);
    expect(asked).toContain(CLIENT_LOWER);
    expect(asked).not.toContain(CLIENT_CHECKSUMMED);
  });
});

describe("the inbox", () => {
  it("shows a message addressed in the other spelling", async () => {
    /* Exactly the row the user's screenshot produced: written before addresses
       were folded, so it carries a mixed-case id nothing will generate again.
       Grouping by the stored conversation_id would lose it. */
    builder = recordingBuilder({
      data: [
        {
          id: "m1",
          conversation_id: [CLIENT_CHECKSUMMED, FREELANCER_CHECKSUMMED].sort().join(":"),
          sender_address: CLIENT_CHECKSUMMED,
          recipient_address: FREELANCER_CHECKSUMMED,
          content: "Hey",
          read_at: null,
          created_at: "2026-09-11T22:18:00Z",
        },
      ],
      error: null,
    });
    supabaseInstance = makeSupabaseMock({ from: () => builder });

    const res = await request(app).get(`/v1/messages/inbox?wallet=${FREELANCER_LOWER}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0]).toMatchObject({
      other_address: CLIENT_LOWER,
      latest_message: "Hey",
      unread: 1,
    });
  });

  it("keeps one thread as one thread across both spellings", async () => {
    const row = (sender: string, recipient: string, content: string, at: string) => ({
      id: content,
      conversation_id: [sender, recipient].sort().join(":"),
      sender_address: sender,
      recipient_address: recipient,
      content,
      read_at: null,
      created_at: at,
    });
    builder = recordingBuilder({
      data: [
        // Written before the fix, checksummed…
        row(CLIENT_CHECKSUMMED, FREELANCER_CHECKSUMMED, "Hey", "2026-09-11T22:18:00Z"),
        // …and after it, folded. Same two people, two stored ids.
        row(CLIENT_LOWER, FREELANCER_LOWER, "Still there?", "2026-09-11T22:20:00Z"),
      ],
      error: null,
    });
    supabaseInstance = makeSupabaseMock({ from: () => builder });

    const res = await request(app).get(`/v1/messages/inbox?wallet=${FREELANCER_CHECKSUMMED}`);

    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].unread).toBe(2);
  });
});

describe("the unread count behind the bell", () => {
  it("counts messages addressed in the other spelling", async () => {
    const res = await request(app).get(`/v1/messages/unread-count?wallet=${FREELANCER_LOWER}`);

    expect(res.status).toBe(200);
    const asked = argsOf(builder);
    expect(asked).toContain(FREELANCER_LOWER);
    // ilike, not eq — otherwise a checksummed row is uncounted and nothing rings.
    expect((builder.__calls as { method: string }[]).some((c) => c.method === "ilike")).toBe(true);
  });
});

describe("marking a thread read", () => {
  it("matches the thread however it was spelled", async () => {
    const res = await request(app).patch(
      `/v1/messages/conversation/read?a=${FREELANCER_CHECKSUMMED}&b=${CLIENT_LOWER}&wallet=${FREELANCER_CHECKSUMMED}`,
    );

    expect(res.status).toBe(200);
    const asked = argsOf(builder);
    expect(asked).toContain(FREELANCER_LOWER);
    expect(asked).not.toContain(FREELANCER_CHECKSUMMED);
  });
});
