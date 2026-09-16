/**
 * What happens to the rest of a job once an arbiter has ruled.
 *
 * A dispute settles one milestone, not the job. The escrow goes back to
 * in-progress with the remaining milestones still funded, and until recently
 * there was nothing the client could do with them: cancelling refuses a job
 * that has a freelancer, and you cannot dispute a milestone nobody submitted.
 * The money sat there until the deadline plus the emergency delay.
 *
 * There are two reasonable endings and the client should pick, not the product:
 * take back what nobody started, or hand the unfinished part to someone else.
 * Both are on-chain and neither can touch work already delivered.
 */
import { useState } from "react";
import { useWriteContract } from "wagmi";
import { useWeb3 } from "@/contexts/web3-context";
import { motion } from "framer-motion";
import { Loader2, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/atelier/errors";
import { contractService } from "@/lib/web3/contract-service";
import type { Milestone } from "@/lib/web3/types";

interface Props {
  escrowId: number;
  isClient: boolean;
  /** "active" here means the contract's InProgress. */
  status: string;
  milestones: Milestone[];
  onDone?: () => void;
}

/** True once an arbiter has ruled on any milestone of this job. */
export function hasSettledDispute(milestones: Milestone[]): boolean {
  return milestones.some((m) => (m.resolvedAt ?? 0) > 0 || m.status === "resolved");
}

/** Milestones nobody has submitted work against, which are the ones in play. */
export function unstartedMilestones(milestones: Milestone[]): number[] {
  return milestones
    .map((m, i) => (m.status === "pending" && Number(m.amount) > 0 ? i : -1))
    .filter((i) => i >= 0);
}

export function PostDisputeChoice({ escrowId, isClient, status, milestones, onDone }: Props) {
  const { writeContractAsync } = useWriteContract();
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"reclaim" | "reopen" | null>(null);

  const unstarted = unstartedMilestones(milestones);
  const settled = hasSettledDispute(milestones);

  // Nothing to offer unless a ruling has happened and something is still
  // unstarted. Rendering an empty panel on every job would be worse than
  // rendering nothing.
  if (!isClient || status !== "active" || !settled || unstarted.length === 0) return null;

  const remaining = unstarted.reduce((sum, i) => sum + Number(milestones[i].amount), 0) / 1e6;

  const reclaim = async () => {
    setBusy("reclaim");
    try {
      // One call per unstarted milestone: the contract refunds against a single
      // milestone at a time so the sum invariant it enforces stays intact.
      for (const i of unstarted) {
        await contractService.withdrawJobFunds(
          {
            escrow_id: escrowId,
            // The service takes a human-readable figure and scales it; the
            // milestone carries USDC's own 6-decimal units.
            withdraw_amount: String(Number(milestones[i].amount) / 1e6),
            depositor: wallet.address ?? "",
            milestone_index: i,
          },
          writeContractAsync,
        );
      }
      toast({
        title: "Budget returned",
        description: `$${remaining.toFixed(2)} came back to your wallet. Work already delivered is unaffected.`,
      });
      onDone?.();
    } catch (e) {
      toast(toastError("Could not return the remaining budget", e));
    } finally {
      setBusy(null);
    }
  };

  const reopen = async () => {
    setBusy("reopen");
    try {
      await contractService.reopenJob(escrowId, writeContractAsync);
      toast({
        title: "Back on the board",
        description:
          "Freelancers can apply for the unfinished part. They can read what was delivered and how the dispute was settled before they do.",
      });
      onDone?.();
    } catch (e) {
      toast(toastError("Could not reopen this job", e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl actor-panel actor-human p-4 sm:p-5 mt-4"
      data-testid="post-dispute-choice"
    >
      <h4 className="font-display text-base font-bold">
        An arbiter has ruled. What happens to the rest?
      </h4>
      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-prose">
        <strong className="text-foreground">${remaining.toFixed(2)}</strong> is still
        held for {unstarted.length} milestone{unstarted.length === 1 ? "" : "s"} nobody
        has started. Work already delivered stays where it is either way.
      </p>

      <div className="flex flex-col sm:flex-row gap-2.5 mt-4">
        <Button variant="outline" onClick={() => void reclaim()} disabled={busy !== null}>
          {busy === "reclaim" ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
          ) : (
            <Undo2 className="h-4 w-4 mr-2" aria-hidden="true" />
          )}
          Return ${remaining.toFixed(2)} to me
        </Button>

        <Button onClick={() => void reopen()} disabled={busy !== null}>
          {busy === "reopen" ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="h-4 w-4 mr-2" aria-hidden="true" />
          )}
          Let someone else finish it
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mt-3 max-w-prose">
        Reopening keeps the whole record — what the last freelancer delivered, what
        the disagreement was, and how it was settled. Anyone applying can read it
        first, which is the only reason picking up a disputed job is a fair thing
        to ask of them.
      </p>
    </motion.div>
  );
}
