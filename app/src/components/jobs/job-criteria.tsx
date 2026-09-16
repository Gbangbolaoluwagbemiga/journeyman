/**
 * WHAT IT TAKES TO GET PAID — shown to the freelancer before they apply.
 *
 * WHY THIS EXISTS
 *
 * The Telegram bot has printed a job's acceptance criteria since the day it
 * existed. The web card printed a title, a budget and a description. Same
 * commission, two different accounts of what the work actually is — and the web,
 * which is where most people find a job, was the half missing the answer.
 *
 * On an Autopilot job this is not a nicety. An agent approves or rejects a
 * submission against these lines specifically. A freelancer who cannot read them
 * is being marked against a rubric they were never shown, and the first time
 * they learn it exists is when their work is rejected.
 */

import { useEffect, useState } from "react";
import { ListChecks, Loader2 } from "lucide-react";
import { fetchJobCriteria, AUTOPILOT_CONFIGURED } from "@/lib/atelier/agent-api";

export function JobCriteria({
  escrowId,
  /** Only agent-run jobs are judged by a generated rubric. */
  managedByAgent,
  className,
}: {
  escrowId: number | null;
  managedByAgent: boolean;
  className?: string;
}) {
  const [criteria, setCriteria] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (escrowId === null || !managedByAgent || !AUTOPILOT_CONFIGURED) return;
    let live = true;
    setFailed(false);
    setCriteria(null);

    const ctrl = new AbortController();
    fetchJobCriteria(escrowId, ctrl.signal)
      .then((c) => { if (live) setCriteria(c.criteria); })
      .catch(() => { if (live) setFailed(true); });

    return () => { live = false; ctrl.abort(); };
  }, [escrowId, managedByAgent]);

  /* A client-run job is judged by a person reading the description, so there is
     no rubric to show and an empty box would imply one exists. */
  if (!managedByAgent || escrowId === null || !AUTOPILOT_CONFIGURED) return null;
  if (failed) return null;

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        <ListChecks className="h-4 w-4 text-[var(--actor-agent)]" aria-hidden="true" />
        What this job is judged on
      </div>

      {criteria === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2 rounded-md border border-dashed">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading the acceptance criteria…
        </div>
      ) : criteria.length === 0 ? (
        /*
         * Said plainly rather than hidden. "No criteria written down" is real
         * information for someone deciding whether to spend an hour on a cover
         * letter — it means the agent will work them out from the description,
         * so the description is the whole brief.
         */
        <div className="text-sm text-muted-foreground px-3 py-2 rounded-md border border-dashed">
          No acceptance criteria are written into this job yet. The agent will
          work them out from the description above, so treat that as the brief.
        </div>
      ) : (
        <>
          <ul className="space-y-1 px-3 py-2 rounded-md border bg-muted/30">
            {criteria.map((c, i) => (
              <li key={i} className="text-sm flex gap-2">
                <span className="text-[var(--actor-agent)] shrink-0" aria-hidden="true">•</span>
                <span className="wrap-break-word">{c}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground mt-1.5">
            An agent approves or rejects your submission against these. Meeting
            them is what releases the milestone payment.
          </p>
        </>
      )}
    </div>
  );
}
