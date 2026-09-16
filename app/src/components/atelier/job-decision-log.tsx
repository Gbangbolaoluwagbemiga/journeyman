/**
 * One job's decision log, inside the client's escrow card.
 *
 * Renders nothing at all when the daemon has no record of this escrow, which is
 * the ordinary case for a manually-managed job. That is why there is no explicit
 * "is this on Autopilot" check here: a job with no agent has no agent decisions,
 * so the absence answers the question without a second round trip.
 *
 * Collapsed by default. The log is the most reassuring thing on the page, but it
 * is also the longest, and a client scanning six jobs for the one needing
 * approval should not have to scroll past forty entries to reach the milestones.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { DecisionLog } from "@/components/atelier/decision-log";
import { useDecisions } from "@/hooks/use-decisions";

export function JobDecisionLog({
  escrowId,
  isClient,
}: {
  escrowId: number | string;
  isClient: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { decisions, loading, error } = useDecisions(escrowId, {
    enabled: isClient,
  });

  // Same rule as AutopilotControl: this is the client's view of their agent.
  if (!isClient) return null;

  if (loading && decisions.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading Autopilot activity…
      </div>
    );
  }

  /*
   * A daemon that is down must not make a job look manual. Saying nothing here
   * would tell the client their agent did nothing, which is a different and much
   * worse claim than "we could not reach it".
   */
  if (error) {
    return (
      <p className="text-xs text-muted-foreground px-1">
        Autopilot’s activity log is unreachable right now — this says nothing
        about the job itself, which is on-chain either way.
      </p>
    );
  }

  if (decisions.length === 0) return null;

  const agentCount = decisions.filter((d) => d.by === "agent").length;

  return (
    <div className="actor-agent">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 rounded-xl actor-panel px-4 py-3 text-left transition-opacity hover:opacity-90"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span className="actor-dot" />
          <span className="font-medium text-sm">Autopilot activity</span>
          <span className="text-xs text-muted-foreground">
            {decisions.length}{" "}
            {decisions.length === 1 ? "decision" : "decisions"}
            {agentCount < decisions.length && " · escalated to a human"}
          </span>
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="mt-3">
          <DecisionLog decisions={decisions} />
        </div>
      )}
    </div>
  );
}
