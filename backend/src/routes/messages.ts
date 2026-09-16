import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { attempt, isUnreachable } from "../lib/degrade.js";

export const messagesRouter = Router();

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * ONE ADDRESS, ONE SPELLING.
 *
 * An Arc address has two equally valid spellings — the checksummed mixed case
 * a wallet hands you, and lowercase. Every comparison in this file was raw
 * string equality, so the two never met: a client messaged a freelancer from
 * the Browse Freelancers page, where the address comes off the chain
 * checksummed, and the freelancer's own session asked for their inbox with the
 * lowercase address the daemon issued their managed wallet. Same two people,
 * two different conversation ids, and a message that existed in the table and
 * was invisible to the person it was addressed to — including to the unread
 * count, so nothing rang either.
 *
 * Addresses are case-insensitive identifiers, so they are folded on the way in
 * and on every comparison. Reads match the address columns case-insensitively
 * rather than the stored `conversation_id`, which keeps the rows written before
 * this fix — with a mixed-case id nothing will ever generate again — readable
 * without a migration. `ilike` is safe here: EVM_ADDR has already established
 * these are hex, so there is no wildcard to inject.
 */
const norm = (addr: string): string => addr.toLowerCase();

function conversationId(a: string, b: string): string {
  return [norm(a), norm(b)].sort().join(":");
}

/** Both directions of one thread, matched however either address was spelled. */
function threadFilter(a: string, b: string): string {
  const [x, y] = [norm(a), norm(b)];
  return (
    `and(sender_address.ilike.${x},recipient_address.ilike.${y}),` +
    `and(sender_address.ilike.${y},recipient_address.ilike.${x})`
  );
}

// POST /v1/messages — send a message
messagesRouter.post("/", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Messages store not configured" });
    return;
  }

  const { sender_address, recipient_address, content } = req.body ?? {};

  if (
    !sender_address || !EVM_ADDR.test(String(sender_address)) ||
    !recipient_address || !EVM_ADDR.test(String(recipient_address))
  ) {
    res.status(400).json({ error: "sender_address and recipient_address must be valid Arc EVM addresses (0x…)" });
    return;
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  if (norm(String(sender_address)) === norm(String(recipient_address))) {
    res.status(400).json({ error: "Cannot message yourself" });
    return;
  }

  const convId = conversationId(sender_address, recipient_address);

  const { data, error } = await attempt(supabase
    .from("messages")
    .insert({
      conversation_id: convId,
      sender_address: norm(String(sender_address)),
      recipient_address: norm(String(recipient_address)),
      content: content.trim().slice(0, 4000),
    })
    .select("id, created_at")
    .single());

  if (error) {
    if (isUnreachable(error)) {
      res.status(503).json({ error: "Messages store unreachable" });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.status(201).json({ id: data.id, created_at: data.created_at });
});

// GET /v1/messages/conversation?a=ADDR1&b=ADDR2&since=ISO — fetch chat thread
messagesRouter.get("/conversation", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ messages: [] });
    return;
  }

  const a = String(req.query.a ?? "").trim();
  const b = String(req.query.b ?? "").trim();
  const since = String(req.query.since ?? "").trim();

  if (!EVM_ADDR.test(a) || !EVM_ADDR.test(b)) {
    res.status(400).json({ error: "a and b must be valid Arc EVM addresses (0x…)" });
    return;
  }

  let query = supabase
    .from("messages")
    .select("id, sender_address, recipient_address, content, read_at, created_at")
    .or(threadFilter(a, b))
    .order("created_at", { ascending: true })
    .limit(200);

  if (since) {
    query = query.gt("created_at", since);
  }

  const { data, error } = await attempt(query);
  if (error) {
    res.json({ messages: [], degraded: true });
    return;
  }

  res.json({ messages: data ?? [] });
});

// GET /v1/messages/inbox?wallet=ADDR — list all conversations with latest message + unread count
messagesRouter.get("/inbox", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ conversations: [] });
    return;
  }

  const wallet = String(req.query.wallet ?? "").trim();
  if (!EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }
  const me = norm(wallet);

  // Fetch messages where user is sender OR recipient, ordered by newest first
  const { data, error } = await attempt(supabase
    .from("messages")
    .select("id, conversation_id, sender_address, recipient_address, content, read_at, created_at")
    .or(`sender_address.ilike.${me},recipient_address.ilike.${me}`)
    .order("created_at", { ascending: false })
    .limit(500));

  if (error) {
    res.json({ conversations: [], degraded: true });
    return;
  }

  // Group by conversation, keep latest message + unread count
  const convMap = new Map<string, {
    conversation_id: string;
    other_address: string;
    latest_message: string;
    latest_at: string;
    unread: number;
  }>();

  for (const row of data ?? []) {
    const sender = norm(row.sender_address);
    const recipient = norm(row.recipient_address);
    const other = sender === me ? recipient : sender;
    /* Grouped by who the thread is WITH, not by the stored conversation_id:
       rows written before addresses were folded carry a mixed-case id, and
       keying off it would split one conversation into two. */
    const key = conversationId(me, other);
    if (!convMap.has(key)) {
      convMap.set(key, {
        conversation_id: key,
        other_address: other,
        latest_message: row.content,
        latest_at: row.created_at,
        unread: 0,
      });
    }
    // Count unread: messages sent TO this wallet that have no read_at
    if (recipient === me && !row.read_at) {
      const entry = convMap.get(key)!;
      entry.unread++;
    }
  }

  res.json({ conversations: Array.from(convMap.values()) });
});

// GET /v1/messages/unread-count?wallet=ADDR — total unread count for badge
messagesRouter.get("/unread-count", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ count: 0 });
    return;
  }

  const wallet = String(req.query.wallet ?? "").trim();
  if (!EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }

  const { count, error } = await attempt(supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .ilike("recipient_address", norm(wallet))
    .is("read_at", null));

  if (error) {
    res.json({ count: 0, degraded: true });
    return;
  }

  res.json({ count: count ?? 0 });
});

// PATCH /v1/messages/conversation/read?a=ADDR1&b=ADDR2&wallet=ADDR — mark all messages in thread as read
messagesRouter.patch("/conversation/read", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Messages store not configured" });
    return;
  }

  const a = String(req.query.a ?? "").trim();
  const b = String(req.query.b ?? "").trim();
  const wallet = String(req.query.wallet ?? "").trim();

  if (!EVM_ADDR.test(a) || !EVM_ADDR.test(b) || !EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "a, b, and wallet must be valid Arc EVM addresses (0x…)" });
    return;
  }

  const { error } = await attempt(supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .or(threadFilter(a, b))
    .ilike("recipient_address", norm(wallet))
    .is("read_at", null));

  if (error) {
    if (isUnreachable(error)) {
      res.status(503).json({ error: "Messages store unreachable" });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.json({ ok: true });
});

// PATCH /v1/messages/:id/read?wallet=ADDR — mark single message as read
messagesRouter.patch("/:id/read", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Messages store not configured" });
    return;
  }

  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid message id" });
    return;
  }

  const wallet = String(req.query.wallet ?? "").trim();
  if (!EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }

  const { error } = await attempt(supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .ilike("recipient_address", norm(wallet))
    .is("read_at", null));

  if (error) {
    if (isUnreachable(error)) {
      res.status(503).json({ error: "Messages store unreachable" });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.json({ ok: true });
});
