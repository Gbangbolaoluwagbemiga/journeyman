import { useState } from "react";
import { useWriteContract } from "wagmi";
import { UserPlus, Globe, Undo2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

/**
 * WHAT HAPPENS TO A JOB THE FREELANCER HANDED BACK.
 *
 * The decline deliberately decides nothing. Only the client knows whether the
 * reason is something they can fix — a budget under someone's rate, a deadline
 * that does not work — or whether they would rather take anyone, or would
 * rather have their money back.
 *
 * So all three are here, in the order a client is most likely to want them,
 * and none of them is a default. The money has not moved and no fee has been
 * charged twice, whichever they pick.
 *
 * It renders only in the one state that means "declined and waiting": funded,
 * Pending, nobody named, not on the board. An open job has not been declined;
 * an assigned one has not been handed back.
 */
export function DeclinedChoice({
  escrowId,
  isClient,
  status,
  beneficiary,
  isOpenJob,
  declinedBy,
  onDone,
}: {
  escrowId: number;
  isClient: boolean;
  status: string;
  beneficiary?: string;
  isOpenJob?: boolean;
  /** Who handed it back, when we know — lets the client re-offer in one click. */
  declinedBy?: string;
  onDone?: () => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const unclaimed = !beneficiary || beneficiary === ZERO;
  const declined = isClient && status === "pending" && unclaimed && isOpenJob === false;
  if (!declined) return null;

  async function run(label: string, fn: (cs: ContractService) => Promise<unknown>, done: string) {
    setBusy(label);
    try {
      await fn(new ContractService(CONTRACTS.ATELIER_ESCROW));
      toast({ title: done });
      onDone?.();
    } catch (err: unknown) {
      toast({
        title: "That didn't go through",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
      data-testid="declined-choice"
    >
      <div>
        <h4 className="font-medium">The freelancer handed this job back</h4>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your money hasn't moved and nothing has been charged. Three ways
          forward — check your messages first if they said why.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {declinedBy && (
          <Button
            variant="outline"
            className="justify-start gap-2 h-auto py-2.5"
            disabled={!!busy}
            data-testid="declined-reoffer"
            onClick={() =>
              run("reoffer", (cs) =>
                cs.acceptFreelancer(
                  { escrow_id: escrowId, freelancer: declinedBy, depositor: "" },
                  writeContractAsync,
                ), "Offered to them again")
            }
          >
            {busy === "reoffer" ? (
              <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span className="text-left text-xs leading-tight">
              Offer it to them again
              <span className="block text-muted-foreground">after meeting their terms</span>
            </span>
          </Button>
        )}

        <Button
          variant="outline"
          className="justify-start gap-2 h-auto py-2.5"
          disabled={!!busy}
          data-testid="declined-open"
          onClick={() => run("open", (cs) => cs.reopenJob(escrowId, writeContractAsync), "Back on the board")}
        >
          {busy === "open" ? (
            <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
          ) : (
            <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="text-left text-xs leading-tight">
            Open it to everyone
            <span className="block text-muted-foreground">anyone can apply</span>
          </span>
        </Button>

        <Button
          variant="outline"
          className="justify-start gap-2 h-auto py-2.5"
          disabled={!!busy}
          data-testid="declined-refund"
          onClick={() => run("refund", (cs) => cs.cancelJob({ escrow_id: escrowId, depositor: "" }, writeContractAsync), "Job cancelled, funds returned")}
        >
          {busy === "refund" ? (
            <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
          ) : (
            <Undo2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="text-left text-xs leading-tight">
            Take the money back
            <span className="block text-muted-foreground">cancels the job</span>
          </span>
        </Button>
      </div>
    </div>
  );
}
