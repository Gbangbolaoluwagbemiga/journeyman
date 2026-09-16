import { useState } from "react";
import { useWriteContract } from "wagmi";
import { Clock, Undo2, MessageCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

/**
 * THE FREELANCER WAS HIRED AND HAS NOT STARTED.
 *
 * WHY THIS IS NOT A DISPUTE
 *
 * The obvious instinct is a dispute button, and it is the wrong instrument.
 * A dispute asks arbiters to judge delivered work: it needs a submitted
 * milestone to rule on, costs real people's attention, and takes days. Here
 * there is nothing to judge — nobody has done anything. Sending this to an
 * arbiter would be asking three humans to confirm that silence is silence.
 *
 * The client is not stranded either, which is the thing worth saying out loud:
 * before a freelancer starts, the money is still theirs and comes back in one
 * transaction. That has been true since the cancel guard moved to
 * `workStarted`, and this panel exists because it was true and invisible — a
 * client had to already know `cancelJob` would work on an assigned job to find
 * their way out of one.
 *
 * WHY IT WAITS BEFORE SAYING ANYTHING
 *
 * Somebody hired two minutes ago is not ghosting anyone. Offering to undo the
 * hire immediately would make the product read as though it expected the
 * freelancer to fail. After a day of silence it is a fair question, and the
 * first thing offered is still a message rather than an exit.
 */

const A_DAY = 24 * 60 * 60 * 1000;

export function WaitingOnFreelancer({
  escrowId,
  isClient,
  status,
  beneficiary,
  hiredAt,
  onMessage,
  onDone,
}: {
  escrowId: number;
  isClient: boolean;
  /* "pending" is the on-chain Pending state, which startWork leaves — so this
     alone means the freelancer has not begun. */
  status: string;
  beneficiary?: string;
  /** When the job was funded or the freelancer accepted, in ms. */
  hiredAt?: number;
  onMessage?: () => void;
  onDone?: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const assigned = !!beneficiary && beneficiary !== ZERO;
  const waitedMs = hiredAt ? Date.now() - hiredAt : 0;

  if (!isClient || !assigned || status !== "pending") return null;
  if (waitedMs < A_DAY) return null;

  const days = Math.floor(waitedMs / A_DAY);

  async function reclaim() {
    setBusy(true);
    try {
      await new ContractService(CONTRACTS.ATELIER_ESCROW).cancelJob(
        { escrow_id: escrowId, depositor: "" },
        writeContractAsync,
      );
      toast({
        title: "Job cancelled, money returned",
        description: "Nobody had applied and nobody had started, so there was no fee.",
      });
      onDone?.();
    } catch (err: unknown) {
      toast({
        title: "Could not cancel",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
      data-testid="waiting-on-freelancer"
    >
      <div className="flex items-start gap-2">
        <Clock className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
        <div>
          <h4 className="font-medium">
            This freelancer hasn't started
            <span className="text-muted-foreground font-normal">
              {" · "}
              {days === 1 ? "1 day" : `${days} days`} since you hired them
            </span>
          </h4>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your money is still yours. Nothing has been released and nothing can
            be until they begin — you can take it back whenever you like, and
            since nobody applied to this job it costs you nothing.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* Offered first on purpose: most silence is a busy week, not a
            disappearance, and one message usually settles it. */}
        {onMessage && (
          <Button variant="outline" size="sm" className="gap-2" onClick={onMessage} data-testid="waiting-message">
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Ask them
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={busy}
          onClick={reclaim}
          data-testid="waiting-reclaim"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Undo2 className="h-4 w-4" aria-hidden="true" />
          )}
          Take my money back
        </Button>
      </div>
    </div>
  );
}
