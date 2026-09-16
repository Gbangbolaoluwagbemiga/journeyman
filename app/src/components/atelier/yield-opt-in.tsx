import { useCallback, useEffect, useState } from "react";
import { Sprout, Loader2 } from "lucide-react";
import { useWriteContract } from "wagmi";
import { useToast } from "@/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

/**
 * "🌱 Escrow yield" — a chip, with the explanation on hover.
 *
 * WHY THIS IS FOUR WORDS AND NOT A PARAGRAPH
 *
 * It was a paragraph, sitting in its own bordered box in the middle of the
 * card, restating the whole mechanism to a client who had already agreed to it
 * when they posted the job. Every job carried it, so every card was longer, and
 * the things a client actually opens a card for — what is owed, what is
 * submitted, what needs approving — were pushed further down.
 *
 * A standing fact about a job is not news, and news is what earns vertical
 * space. The chip says the fact; the tooltip holds the detail for the one
 * reading in ten who wants it.
 *
 * The pattern is deliberately {@link AutopilotBadge}'s, down to the delay and
 * the `cursor-help`: these two chips answer the same shape of question about
 * the same card, and the reader should not have to learn two idioms.
 *
 * It renders nothing on a job that does not earn — an "off" state would be
 * chrome describing the absence of a feature.
 *
 * THE ONE CASE WHERE IT IS STILL A CONTROL
 *
 * A job whose yield question has never been answered, and whose freelancer has
 * not started, can still be answered — the contract says so, and the UI should
 * not be stricter than the contract. That happens to jobs posted before the
 * question existed, and to jobs whose opt-in did not survive a controller being
 * replaced.
 *
 * Offering an unanswered question is not the same as re-opening a settled one.
 * The thing that was wrong before was a switch that could be flipped back after
 * a freelancer took the job on the strength of it; the contract now refuses
 * that outright, so anything the UI offers here is an offer the chain will
 * honour or reject on its own terms.
 */
export function YieldOptIn({
  escrowId,
  status,
  isClient,
  onDone,
}: {
  escrowId: number;
  /* A settled job has nothing left to say about what its escrow is doing. */
  status?: string;
  isClient?: boolean;
  onDone?: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const [state, setState] = useState<{
    available: boolean;
    optedIn: boolean;
    choiceMade: boolean;
    deployed: bigint;
    freelancerShareBP: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    let live = true;
    new ContractService(CONTRACTS.ATELIER_ESCROW)
      .getYieldStatus(escrowId)
      .then((next) => { if (live) setState(next); })
      .catch(() => {});
    return () => { live = false; };
  }, [escrowId]);

  useEffect(() => load(), [load]);

  const settled = status === "completed" || status === "cancelled";

  /* Unanswered, still answerable, and the client's to answer. */
  if (state && !state.optedIn && !state.choiceMade && state.available && isClient && !settled) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={busy}
              data-testid="yield-offer"
              onClick={async () => {
                setBusy(true);
                try {
                  await new ContractService(CONTRACTS.ATELIER_ESCROW).setYieldOptIn(
                    escrowId,
                    true,
                    writeContractAsync,
                  );
                  toast({
                    title: "This escrow will earn while the job runs",
                    description:
                      "Only the part no milestone can claim yet, and the decision is final from here.",
                  });
                  load();
                  onDone?.();
                } catch (err: unknown) {
                  toast({
                    title: "Could not switch it on",
                    description: err instanceof Error ? err.message : String(err),
                    variant: "destructive",
                  });
                } finally {
                  setBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-emerald-500/40 px-2.5 py-0.5 text-xs font-medium text-emerald-500/80 hover:bg-emerald-500/10 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sprout className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Earn while it waits?
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">Put this escrow to work.</p>
            <p className="text-xs mt-1.5 leading-relaxed">
              The part of the budget no milestone can claim yet is invested while
              the job runs, and the freelancer takes the larger share of what it
              earns.
            </p>
            {/*
              Said plainly, because the posting screen makes a different and
              better offer. Waiving the fee happens in the creating transaction;
              this job already paid one, and nothing here gets it back — 2.5%
              refunded out of yield needs a 228-day job at 10% APY.

              So this is a gift to whoever takes the job, and a reason for a
              better freelancer to take it. That is worth doing and worth being
              honest about, but it is not a saving.
            */}
            <p className="text-xs mt-1.5 leading-relaxed">
              This job has already paid its platform fee, so switching this on
              now costs you nothing and saves you nothing — it gives the
              freelancer a share, and the job a 🌱 tag on the board.
            </p>
            <p className="text-xs mt-1.5 leading-relaxed">
              Answered once. You cannot turn it off afterwards, which is what
              makes it a term a freelancer can rely on.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (!state?.optedIn) return null;
  if (settled) return null;

  const share = state.freelancerShareBP
    ? `${Math.round(state.freelancerShareBP / 100)}%`
    : "the larger share";
  const deployed = state.deployed > 0n
    ? `$${(Number(state.deployed) / 1e6).toFixed(2)}`
    : null;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-500 cursor-help"
            aria-label="This escrow earns while the job runs"
            data-testid="yield-status"
          >
            {/* Breathes, because the escrow is working right now — see
                .yield-live in index.css. Holds still under
                prefers-reduced-motion. */}
            <Sprout className="h-3.5 w-3.5 text-emerald-500 yield-live" aria-hidden="true" />
            Escrow yield
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">This escrow earns while the job runs.</p>
          <p className="text-xs mt-1.5 leading-relaxed">
            The part of the budget no milestone can claim yet is invested. What
            it earns covers the platform fee first; {share} of anything beyond
            that goes to the freelancer.
          </p>
          <p className="text-xs mt-1.5 leading-relaxed">
            Agreed when the job was posted and fixed since — it cannot be turned
            off once someone is hired.
          </p>
          {deployed && (
            <p className="text-xs mt-1.5 font-medium" data-testid="yield-deployed">
              {deployed} is out earning right now.
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
