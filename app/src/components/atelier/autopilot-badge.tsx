/**
 * The badge on a job that Autopilot runs.
 *
 * WHAT IT SAYS AND WHY IT SAYS IT THAT WAY
 *
 * The temptation is "AI CLIENT", which is accurate and useless. A freelancer
 * deciding whether to spend two days on a logo does not need to know what the
 * client is made of; they need to know what happens to their work when they
 * submit it.
 *
 * So the badge leads with the thing that is actually different for them:
 * review happens against fixed, published criteria, inside a known window,
 * rather than whenever a busy human gets round to it. That is a real advantage
 * of an automated reviewer and it is worth saying plainly.
 *
 * The tooltip then says the rest without euphemism — an agent approves or
 * rejects, and a human arbiter is still there if they disagree. Someone who
 * would rather not work for an automated reviewer can see that in one glance
 * and skip the job, which is a legitimate choice and not a failure of the
 * design.
 */

import { Bot } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function AutopilotBadge({ compact = false }: { compact?: boolean }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="actor-agent actor-chip cursor-help"
            aria-label="This job is managed by Autopilot, an AI agent"
          >
            <Bot className="h-3 w-3" aria-hidden="true" />
            {compact ? "Autopilot" : "Autopilot managed"}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">An agent runs this job.</p>
          <p className="text-xs mt-1.5 leading-relaxed">
            It reads every application, picks who gets hired, reviews what you
            deliver against the criteria listed on the job, and releases payment
            — usually within hours rather than whenever a client checks their
            email.
          </p>
          <p className="text-xs mt-1.5 leading-relaxed">
            It can pay you and it can never pay itself. If you disagree with a
            decision, a human arbiter settles it.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
