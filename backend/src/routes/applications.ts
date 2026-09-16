import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";

export const applicationsRouter = Router();

// Store application data when freelancer applies
applicationsRouter.post("/", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { escrow_id, freelancer_address, cover_letter, proposed_timeline } = req.body ?? {};

  if (!escrow_id || !freelancer_address) {
    res.status(400).json({ error: "escrow_id and freelancer_address are required" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("applications")
      .upsert({
        escrow_id: Number(escrow_id),
        freelancer_address: String(freelancer_address).toLowerCase(),
        cover_letter: cover_letter || "",
        proposed_timeline: Number(proposed_timeline) || 0,
        applied_at: new Date().toISOString(),
      }, {
        onConflict: "escrow_id,freelancer_address"
      })
      .select("id")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(201).json({ id: data.id, success: true });
  } catch (error: any) {
    /*
     * A write must never report success it did not achieve.
     *
     * The application itself lives on-chain — `applyForJob` emits the event the
     * agent reads. This row is the cover letter beside it, so losing it is
     * survivable, but the caller has to be told, or a freelancer believes they
     * sent a pitch that nobody will ever see.
     */
    res.status(503).json({ error: "Application store unreachable", detail: String(error?.message ?? error) });
  }
});

// Get applications for an escrow
applicationsRouter.get("/:escrowId", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ applications: [] });
    return;
  }

  const escrowId = Number(req.params.escrowId);
  if (isNaN(escrowId)) {
    res.status(400).json({ error: "Invalid escrow ID" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .eq("escrow_id", escrowId)
      .order("applied_at", { ascending: false });

    if (error) {
      res.json({ applications: [], degraded: true });
      return;
    }

    res.json({ applications: data || [] });
  } catch (error: any) {
    // Unreachable store, not a bad request: an empty list is the honest answer.
    res.json({ applications: [], degraded: true, detail: String(error?.message ?? error) });
  }
});
