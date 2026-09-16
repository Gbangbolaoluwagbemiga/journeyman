import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";
import { attempt, isUnreachable } from "../lib/degrade.js";

export const notificationsRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

notificationsRouter.get("/", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ notifications: [] });
    return;
  }

  const walletRaw = String(req.query.wallet ?? "").trim();
  if (!walletRaw || !/^0x[0-9a-fA-F]{40}$/.test(walletRaw)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }
  // Normalize to lowercase — wagmi returns checksum case but writers may use lowercase.
  const wallet = walletRaw.toLowerCase();

  /*
   * An unreachable store reads as "no notifications", not as an error.
   *
   * The !supabase branch above only catches a store that was never configured.
   * A configured store whose host has stopped resolving throws inside the
   * client instead, and with no catch here that surfaced to the browser as
   * `TypeError: fetch failed` — a 500 on a bell icon, on every page load. An
   * empty bell is the honest degradation: the user has no notifications we can
   * show them, and nothing else on the page is broken.
   */
  // ilike makes this case-insensitive so historical rows in mixed case still surface.
  const { data, error } = await attempt(
    supabase
      .from("notifications")
      .select(
        "id, wallet_address, type, title, message, read_at, action_url, data, created_at",
      )
      .ilike("wallet_address", wallet)
      .order("created_at", { ascending: false })
      .limit(100),
  );

  if (error) {
    res.json({ notifications: [], degraded: true });
    return;
  }

  const notifications = (data ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    read: !!row.read_at,
    timestamp: row.created_at,
    actionUrl: row.action_url ?? undefined,
    data: row.data ?? {},
  }));

  res.json({ notifications });
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Notifications store not configured" });
    return;
  }

  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid notification id" });
    return;
  }

  const walletRaw = String(req.query.wallet ?? "").trim();
  if (!walletRaw || !/^0x[0-9a-fA-F]{40}$/.test(walletRaw)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }
  const wallet = walletRaw.toLowerCase();

  const { error } = await attempt(
    supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .ilike("wallet_address", wallet),
  );

  if (error) {
    if (isUnreachable(error)) {
      res.status(503).json({ error: "Notifications store unreachable" });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.json({ ok: true });
});

notificationsRouter.post("/", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Notifications store not configured" });
    return;
  }

  const {
    wallet_address,
    type,
    title,
    message,
    action_url,
    data: payload,
  } = req.body ?? {};

  const walletRaw = String(wallet_address ?? "").trim();
  if (!walletRaw || !/^0x[0-9a-fA-F]{40}$/.test(walletRaw)) {
    res.status(400).json({ error: "wallet_address must be a valid Arc EVM address (0x…)" });
    return;
  }
  // Always store wallets in lowercase so reads + writes match regardless of casing.
  const wallet = walletRaw.toLowerCase();

  if (!type || !title || !message) {
    res.status(400).json({ error: "type, title, and message are required" });
    return;
  }

  const { data, error } = await attempt(
    supabase
      .from("notifications")
      .insert({
        wallet_address: wallet,
        type: String(type),
        title: String(title),
        message: String(message),
        action_url: action_url ? String(action_url) : null,
        data: payload && typeof payload === "object" ? payload : {},
      })
      .select("id")
      .single(),
  );

  if (error) {
    if (isUnreachable(error)) {
      res.status(503).json({ error: "Notifications store unreachable" });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.status(201).json({ id: data.id });
});
