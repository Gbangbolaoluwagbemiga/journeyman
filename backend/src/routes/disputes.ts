/**
 * THE ARBITER'S REASONING, WHERE BOTH SIDES CAN READ IT.
 *
 * WHY THIS EXISTS
 *
 * When a human settles a dispute they write why. That sentence was saved to
 * localStorage in the browser of whoever resolved it, and the contract's
 * DisputeResolved event carries the amounts but not the reason — so it existed
 * in exactly one place, on one machine, belonging to one party.
 *
 * The client could read it. The freelancer, whose payment it had just decided,
 * could not, from any device, ever. They were told the dispute was resolved and
 * left to work out what that meant from their balance.
 *
 * A decision that one party can read and the other cannot is not arbitration.
 *
 * WHO MAY WRITE ONE
 *
 * Only the arbiter who actually resolved it, proven twice over: they sign a
 * message naming the escrow and milestone, and the address that signed must
 * match the arbiter in the on-chain DisputeResolved event for that exact
 * milestone. Without the second check a signature from anybody would do, and
 * the reasoning behind a payment would be a thing strangers could write.
 *
 * Reading is open. It is a decision about two named parties on a public chain,
 * and keeping the reason behind a login while the amounts are visible to
 * everyone would protect nothing.
 */
import { Router } from "express";
import { createPublicClient, http, verifyMessage, parseAbiItem } from "viem";
import { getSupabase } from "../lib/supabase.js";

export const disputesRouter = Router();

const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}` | undefined;
const publicClient = createPublicClient({ transport: http(ARC_RPC_URL) });

const DISPUTE_RESOLVED = parseAbiItem(
  "event DisputeResolved(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed arbiter, uint256 freelancerAmount, uint256 clientAmount, uint256 timestamp)",
);

/* How far back to look for the resolution being described. Windowed because a
   public RPC refuses a wide getLogs range outright rather than truncating it,
   and refuses "earliest" altogether. */
const LOG_RANGE = 9000n;
const SEARCH_WINDOWS = 40n; // ~360k blocks — far more than the minutes this needs

/** How long a signed resolution note stays valid. */
const AUTH_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_REASON = 2000;

/** Must match the client's helper byte for byte. */
export function buildResolutionAuthMessage(
  escrowId: string,
  milestoneIndex: string,
  arbiter: string,
  timestamp: string,
): string {
  return [
    "Atelier dispute resolution note",
    `Escrow: ${escrowId}`,
    `Milestone: ${milestoneIndex}`,
    `Arbiter: ${arbiter.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

/**
 * Did this address actually resolve this milestone?
 *
 * Read from the chain rather than trusted from the request. Returns false when
 * there is no contract configured — refusing to write is the safe direction,
 * because a note nobody can attribute is worse than no note.
 */
async function isTheArbiter(
  escrowId: string,
  milestoneIndex: string,
  address: string,
): Promise<boolean> {
  if (!CONTRACT_ADDRESS) return false;

  /*
   * Searched backwards in windows, not in one sweep from the genesis block.
   *
   * `fromBlock: "earliest"` is refused outright by the RPC — the request comes
   * back as a failure, not a truncated result, so this returned false for
   * EVERY caller including the real arbiter. The write path could never have
   * worked, and the unit tests did not catch it because they mock getLogs.
   *
   * Backwards because a note is written seconds after the resolution it
   * describes, so the match is almost always in the first window. The bound
   * stops an unanswerable request turning into an unbounded scan.
   */
  try {
    const latest = await publicClient.getBlockNumber();
    const args = {
      escrowId: BigInt(escrowId),
      milestoneIndex: BigInt(milestoneIndex),
      arbiter: address as `0x${string}`,
    };

    for (let i = 0n; i < SEARCH_WINDOWS; i++) {
      const to = latest - i * LOG_RANGE;
      if (to <= 0n) break;
      const from = to > LOG_RANGE ? to - LOG_RANGE : 0n;

      const logs = await publicClient.getLogs({
        address: CONTRACT_ADDRESS,
        event: DISPUTE_RESOLVED,
        args,
        fromBlock: from,
        toBlock: to,
      });
      if (logs.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

disputesRouter.post("/resolution", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const escrowId = String(req.body?.escrow_id ?? "");
  const milestoneIndex = String(req.body?.milestone_index ?? "");
  const arbiter = String(req.body?.arbiter_address ?? "");
  const signature = String(req.body?.signature ?? "");
  const timestamp = String(req.body?.timestamp ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  /* Optional: the split, so reading a settled dispute never depends on a log
     scan that only looks back a fixed and surprisingly short distance. */
  const freelancerAmount = req.body?.freelancer_amount;
  const clientAmount = req.body?.client_amount;

  if (!/^\d+$/.test(escrowId) || !/^\d+$/.test(milestoneIndex)) {
    res.status(400).json({ error: "escrow_id and milestone_index are required" });
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(arbiter)) {
    res.status(400).json({ error: "arbiter_address must be a valid address" });
    return;
  }
  if (!reason) {
    res.status(400).json({ error: "A resolution needs a reason — it is the whole point of writing it down." });
    return;
  }
  if (reason.length > MAX_REASON) {
    res.status(400).json({ error: `Keep the reason under ${MAX_REASON} characters.` });
    return;
  }

  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > AUTH_MAX_AGE_MS) {
    res.status(401).json({ error: "That authorization has expired — resolve and save again." });
    return;
  }

  const message = buildResolutionAuthMessage(escrowId, milestoneIndex, arbiter, timestamp);
  const signed = await verifyMessage({
    address: arbiter as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!signed) {
    res.status(401).json({ error: "Signature did not verify." });
    return;
  }

  if (!(await isTheArbiter(escrowId, milestoneIndex, arbiter))) {
    res.status(403).json({
      error: "Only the arbiter who resolved this milestone can record why.",
    });
    return;
  }

  try {
    const { error } = await supabase
      .from("dispute_resolutions")
      .upsert(
        {
          escrow_id: Number(escrowId),
          milestone_index: Number(milestoneIndex),
          arbiter_address: arbiter.toLowerCase(),
          reason,
          freelancer_amount: freelancerAmount != null ? Number(freelancerAmount) : null,
          client_amount: clientAmount != null ? Number(clientAmount) : null,
          resolved_at: new Date().toISOString(),
        },
        { onConflict: "escrow_id,milestone_index" },
      );

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json({ success: true });
  } catch (err: any) {
    /* The resolution itself is on-chain and already happened. This note is the
       explanation beside it — losing it is survivable, but saying it saved when
       it did not would leave an arbiter believing they had explained. */
    res.status(500).json({ error: err?.message ?? "Could not save the resolution note" });
  }
});

/** Every recorded reason for one escrow. Open, like the amounts already are. */
disputesRouter.get("/resolution", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(200).json({ resolutions: [] });
    return;
  }

  const escrowId = String(req.query.escrow_id ?? "");
  if (!/^\d+$/.test(escrowId)) {
    res.status(400).json({ error: "escrow_id is required" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from("dispute_resolutions")
      .select("milestone_index, arbiter_address, reason, freelancer_amount, client_amount, resolved_at")
      .eq("escrow_id", Number(escrowId));

    if (error) {
      /*
       * A missing table is a deployment that has not run the migration yet,
       * not a broken request. Answering "no notes recorded" lets every screen
       * that asks keep working — they all render nothing for an empty list —
       * whereas a 500 here would take a job card down over an explanation that
       * was never written.
       */
      if (/relation .* does not exist|schema cache/i.test(error.message)) {
        res.status(200).json({ resolutions: [] });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json({ resolutions: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Could not read the resolution notes" });
  }
});
