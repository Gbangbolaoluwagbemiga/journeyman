import { useState } from "react";
import { User, Copy, Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * WHO IS ON THIS JOB.
 *
 * A client could see that a job was assigned and not to whom. The address was
 * on chain the whole time and nowhere on the card — so telling two jobs apart,
 * or checking you hired the person you meant to, meant opening a block
 * explorer.
 *
 * Six characters and four, because that is enough to recognise an address you
 * already know and not enough to mistake for one you don't. The full string is
 * one hover away, with a copy button, since the reason to want all forty
 * characters is almost always to paste them somewhere.
 *
 * Renders nothing when nobody is assigned. An open job has no answer to give
 * and a placeholder would be worse than silence.
 */
export function AssigneeChip({
  address,
  label = "Freelancer",
}: {
  address?: string;
  /** "Freelancer" on the client's card; "Client" on the freelancer's. */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const ZERO = "0x0000000000000000000000000000000000000000";

  if (!address || address === ZERO) return null;

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* A browser that refuses clipboard access is not an error worth a toast —
         the full address is on screen and can be selected by hand. */
    }
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground cursor-help"
            aria-label={`${label}: ${address}`}
            data-testid="assignee-chip"
          >
            <User className="h-3 w-3 shrink-0" aria-hidden="true" />
            {short}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-xs font-medium">{label}</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="font-mono text-[11px] break-all" data-testid="assignee-full">
              {address}
            </code>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy address"
              data-testid="assignee-copy"
              className="shrink-0 rounded p-1 hover:bg-muted"
            >
              {copied ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Copy className="h-3 w-3" aria-hidden="true" />
              )}
            </button>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
