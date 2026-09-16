import { useState, useEffect } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useWeb3 } from "@/contexts/web3-context";
import { useNotifications } from "@/contexts/notification-context";
import { CONTRACTS } from "@/lib/web3/config";
import { PlusCircle, MinusCircle, XCircle, AlertTriangle, Info, ListPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatTokenAmount } from "@/lib/utils";

interface MilestoneSummary {
  index: number;
  description: string;
  amount: string; // wei string
}

interface JobManagementProps {
  escrowId: string;
  isOpenJob: boolean;
  isClient: boolean;
  totalAmount: string; // wei string
  token: string;
  milestones?: MilestoneSummary[];
  beneficiary?: string;
  projectTitle?: string;
  onUpdate?: () => void;
}

const DECIMALS = 6; // Arc USDC

function weiToUsdc(wei: string): number {
  return parseFloat(wei) / 10 ** DECIMALS;
}

/**
 * Wait for a transaction, and believe the receipt.
 *
 * A MINED TRANSACTION IS NOT A SUCCESSFUL ONE. All three handlers on this card
 * awaited the receipt and then ignored `status`, so a revert rendered a success
 * toast: "Funds withdrawn ✓ — 4.000000 USDC removed from Milestone 1" over a
 * job whose chain state had not moved. The client goes looking for money that
 * was never sent, and the only evidence is a toast that lied.
 *
 * It is a function rather than three inline checks because this exact mistake
 * has now been made in four places in this codebase — use-job-manager.ts, and
 * every handler here — and the fix kept not travelling. There is one place to
 * get it right now.
 */
async function settle(
  publicClient: { waitForTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<{ status: string }> } | undefined,
  hash: `0x${string}` | undefined,
  whatDidNotHappen: string,
  /* Called on success, because every caller here moves the client's own money
     and the header is where they look to confirm it. Waiting up to fifteen
     seconds for the next poll is how "did that work?" starts. */
  onSettled?: () => void,
): Promise<void> {
  if (!publicClient || !hash) return;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(
      `The transaction was mined but reverted, so ${whatDidNotHappen}. Nothing was charged beyond gas.`,
    );
  }
  onSettled?.();
}

function usdcToWei(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10 ** DECIMALS));
}

export function JobManagement({
  escrowId,
  isOpenJob,
  isClient,
  totalAmount,
  token,
  milestones = [],
  beneficiary,
  projectTitle,
  onUpdate,
}: JobManagementProps) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { toast } = useToast();
  const { wallet, refreshBalance } = useWeb3();
  const { addCrossWalletNotification } = useNotifications();

  // ── Add Funds ────────────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addTotal, setAddTotal] = useState("");
  // Per-milestone allocation map: milestoneIndex → amount to add (USDC string)
  const [addAllocations, setAddAllocations] = useState<Record<number, string>>({});
  const [selectedAddMilestone, setSelectedAddMilestone] = useState<number | null>(
    milestones.length === 1 ? 0 : null,
  );

  // ── Withdraw Funds ────────────────────────────────────────────────────────
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawTotal, setWithdrawTotal] = useState("");
  const [selectedWithdrawMilestone, setSelectedWithdrawMilestone] = useState<number | null>(
    milestones.length === 1 ? 0 : null,
  );

  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentTotal = weiToUsdc(totalAmount);
  const addTotalNum = parseFloat(addTotal || "0");
  const withdrawTotalNum = parseFloat(withdrawTotal || "0");

  // Only show for open jobs before freelancer assigned, client only
  if (!isOpenJob || !isClient) return null;


  // ── Add Funds handler ─────────────────────────────────────────────────────
  const handleAddFunds = async () => {
    if (addTotalNum <= 0) {
      toast({ title: "Invalid amount", description: "Enter a positive USDC amount.", variant: "destructive" });
      return;
    }
    if (milestones.length > 0 && selectedAddMilestone === null) {
      toast({ title: "Select a milestone", description: "Choose which milestone these funds go to.", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      toast({ title: "Adding funds…", description: "Confirm in your wallet." });

      const addHash = await cs.addJobFunds(
        {
          escrow_id: Number(escrowId),
          additional_amount: addTotal,
          depositor: wallet.address || "",
          milestone_index: selectedAddMilestone ?? 0,
        },
        writeContractAsync,
      );

      // Wait for the block to be confirmed before refreshing UI state
      await settle(publicClient, addHash, "no funds were added", () => void refreshBalance());

      toast({
        title: "Funds added ✓",
        description: selectedAddMilestone !== null
          ? `${addTotalNum.toFixed(6)} USDC added to Milestone ${selectedAddMilestone + 1}.`
          : `${addTotalNum.toFixed(6)} USDC added.`,
      });

      setAddOpen(false);
      setAddTotal("");
      setSelectedAddMilestone(milestones.length === 1 ? 0 : null);
      onUpdate?.();
    } catch (error: any) {
      toast({ title: "Failed to add funds", description: error.message || "Transaction failed", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Withdraw Funds handler ────────────────────────────────────────────────
  const handleWithdrawFunds = async () => {
    if (withdrawTotalNum <= 0) {
      toast({ title: "Invalid amount", description: "Enter a positive USDC amount.", variant: "destructive" });
      return;
    }
    if (withdrawTotalNum > currentTotal) {
      toast({ title: "Exceeds balance", description: `Cannot withdraw more than ${currentTotal.toFixed(6)} USDC.`, variant: "destructive" });
      return;
    }
    if (milestones.length > 0 && selectedWithdrawMilestone === null) {
      toast({ title: "Select a milestone", description: "Choose which milestone to reduce.", variant: "destructive" });
      return;
    }
    // Guard: don't let client reduce below zero for the chosen milestone
    if (
      selectedWithdrawMilestone !== null &&
      milestones[selectedWithdrawMilestone] &&
      withdrawTotalNum > weiToUsdc(milestones[selectedWithdrawMilestone].amount)
    ) {
      toast({
        title: "Amount too large",
        description: `Milestone ${selectedWithdrawMilestone + 1} only has ${weiToUsdc(milestones[selectedWithdrawMilestone].amount).toFixed(6)} USDC. Reduce a smaller amount.`,
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      toast({ title: "Withdrawing funds…", description: "Confirm in your wallet." });

      const withdrawHash = await cs.withdrawJobFunds(
        {
          escrow_id: Number(escrowId),
          withdraw_amount: withdrawTotal,
          depositor: wallet.address || "",
          milestone_index: selectedWithdrawMilestone ?? 0,
        },
        writeContractAsync,
      );

      // Wait for confirmation before refreshing
      await settle(publicClient, withdrawHash, "nothing was withdrawn", () => void refreshBalance());

      toast({
        title: "Funds withdrawn ✓",
        description: selectedWithdrawMilestone !== null
          ? `${withdrawTotalNum.toFixed(6)} USDC removed from Milestone ${selectedWithdrawMilestone + 1}.`
          : `${withdrawTotalNum.toFixed(6)} USDC returned to your wallet.`,
      });

      setWithdrawOpen(false);
      setWithdrawTotal("");
      setSelectedWithdrawMilestone(milestones.length === 1 ? 0 : null);
      onUpdate?.();
    } catch (error: any) {
      toast({ title: "Failed to withdraw", description: error.message || "Transaction failed", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Cancel Job handler ────────────────────────────────────────────────────
  const handleCancelJob = async () => {
    setIsSubmitting(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      // Snapshot applicants BEFORE cancelling — once the job is cancelled the
      // escrow is gone, so this is the last chance to know who to notify.
      const applicants = await cs.getApplicationDetails(Number(escrowId)).catch(() => []);

      toast({ title: "Cancelling job…", description: "Confirm in your wallet." });
      await cs.cancelJob({ escrow_id: Number(escrowId), depositor: wallet.address || "" }, writeContractAsync);
      toast({ title: "Job cancelled", description: "Your funds have been refunded." });

      const title = projectTitle || `Job #${escrowId}`;
      for (const applicant of applicants) {
        addCrossWalletNotification(
          {
            type: "application",
            title: "Job Cancelled",
            message: `The client cancelled "${title}" before selecting a freelancer. No further action is needed.`,
            actionUrl: `/browse-jobs`,
            data: {
              jobId: Number(escrowId),
              freelancerAddress: applicant.freelancer,
              action: "job_cancelled",
            },
          },
          undefined, // clientAddress (not needed here)
          applicant.freelancer, // freelancerAddress
        );
      }

      onUpdate?.();
    } catch (error: any) {
      toast({ title: "Failed to cancel", description: error.message || "Transaction failed", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ── Editing the stage list ────────────────────────────────────────────────
   *
   * Asked for directly, and the old answer was "cancel and post it again" —
   * addJobFunds could only grow a stage that already existed. Cancelling is
   * priced to discourage exactly that: free three times, then 5%, 10%, 15%,
   * plus a penalty scaled to the applications already received. Deciding a job
   * needs one more stage is not abuse.
   *
   * The editor sends the list the client is LOOKING AT, not a delta. That is
   * deliberate: setMilestones replaces, so a list assembled from a stale or
   * failed read would quietly drop stages. What is on screen is what they are
   * agreeing to.
   */
  const [editOpen, setEditOpen] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [draft, setDraft] = useState<{ amount: string; requirements: string }[]>([]);

  /* Whether the DEPLOYED contract has the function. The source is ahead of the
     proxy, so this is asked of the chain rather than assumed — the editor
     appears the moment the implementation is upgraded, with no app redeploy. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { ContractService } = await import("@/lib/web3/contract-service");
        const ok = await new ContractService(CONTRACTS.ATELIER_ESCROW).supportsMilestoneEditing();
        if (!cancelled) setCanEdit(ok);
      } catch {
        /* Leave it hidden. A button that reverts is worse than one absent. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openEditor() {
    setDraft(
      (milestones ?? []).map((m) => ({
        amount: weiToUsdc(m.amount).toString(),
        requirements: m.description ?? "",
      })),
    );
    setEditOpen(true);
  }

  const draftTotal = draft.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);
  const draftDelta = draftTotal - currentTotal;
  const draftValid =
    draft.length > 0 &&
    draft.every((m) => (parseFloat(m.amount) || 0) > 0 && m.requirements.trim().length > 0);

  const handleSaveMilestones = async () => {
    if (!draftValid) {
      toast({
        title: "Every stage needs an amount and a description",
        description: "Remove any you do not want rather than leaving them blank.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      const hash = await cs.setMilestones(
        {
          escrow_id: Number(escrowId),
          milestones: draft.map((m) => ({
            amount: usdcToWei(parseFloat(m.amount)).toString(),
            requirements: m.requirements.trim(),
          })),
          depositor: wallet.address || "",
        },
        writeContractAsync,
      );

      /*
       * A MINED TRANSACTION IS NOT A SUCCESSFUL ONE.
       *
       * This waited for the receipt and then ignored what it said, so the first
       * real edit reverted on a missing allowance and the card announced
       * "Stages updated. You funded 2.00 USDC more" over a job that had not
       * changed by a cent. The same mistake was fixed in use-job-manager.ts
       * earlier and not carried across to here.
       */
      await settle(publicClient, hash, "the stages are unchanged", () => void refreshBalance());

      toast({
        title: "Stages updated",
        description:
          draftDelta > 0
            ? `You funded ${draftDelta.toFixed(2)} USDC more, plus the fee on it.`
            : draftDelta < 0
              ? `${Math.abs(draftDelta).toFixed(2)} USDC came back to you, with its fee.`
              : "Same budget, different stages.",
      });
      setEditOpen(false);
      onUpdate?.();
    } catch (error: any) {
      toast({
        title: "Could not update the stages",
        description: error?.shortMessage || error?.message || "Transaction failed",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card className="glass border-primary/20 p-4 mt-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Job Management</h3>
        <span className="text-sm text-muted-foreground">
          Budget: {currentTotal.toFixed(4)} USDC
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* ── Edit the stages ──────────────────────────────────────────────
            Shown only when the deployed contract can actually do it, so this
            ships before the upgrade without offering a button that reverts. */}
        {canEdit && (
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" onClick={openEditor}>
                <ListPlus className="h-4 w-4" aria-hidden="true" />
                Edit stages
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Edit the stages</DialogTitle>
                <DialogDescription>
                  Add, remove or re-word them while nobody has started. Once a
                  freelancer begins, the stages are the deal and this closes.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                {draft.map((m, i) => (
                  <div key={i} className="rounded-lg border border-border/50 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">Stage {i + 1}</Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                        disabled={draft.length === 1}
                        title={draft.length === 1 ? "A job needs at least one stage" : "Remove this stage"}
                      >
                        Remove
                      </Button>
                    </div>
                    <Input
                      value={m.requirements}
                      onChange={(e) =>
                        setDraft(draft.map((d, j) => (j === i ? { ...d, requirements: e.target.value } : d)))
                      }
                      placeholder="What this stage has to contain"
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={m.amount}
                        onChange={(e) =>
                          setDraft(draft.map((d, j) => (j === i ? { ...d, amount: e.target.value } : d)))
                        }
                        className="w-32"
                      />
                      <span className="text-xs text-muted-foreground">USDC</span>
                    </div>
                  </div>
                ))}
              </div>

              <Button
                variant="outline"
                size="sm"
                className="gap-2 w-full"
                onClick={() => setDraft([...draft, { amount: "", requirements: "" }])}
              >
                <PlusCircle className="h-4 w-4" aria-hidden="true" />
                Add a stage
              </Button>

              {/* The money consequence, before they sign rather than after. */}
              <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">New budget</span>
                  <span className="tabular-nums">{draftTotal.toFixed(2)} USDC</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {draftDelta > 0 ? "You will fund" : draftDelta < 0 ? "Comes back to you" : "No change"}
                  </span>
                  <span className="tabular-nums">
                    {draftDelta === 0 ? "—" : `${Math.abs(draftDelta).toFixed(2)} USDC`}
                  </span>
                </div>
                {draftDelta !== 0 && (
                  <p className="text-xs text-muted-foreground pt-1">
                    The platform fee follows it, {draftDelta > 0 ? "charged on the increase" : "refunded on the reduction"}.
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button onClick={handleSaveMilestones} disabled={isSubmitting || !draftValid}>
                  {isSubmitting ? "Saving…" : "Save the stages"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* ── Add Funds Dialog ─────────────────────────────────────────── */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <PlusCircle className="h-4 w-4" />
              Add Funds
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-[min(480px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add Funds &amp; Allocate to Milestone</DialogTitle>
              <DialogDescription>
                Choose how much to add and which milestone should receive the new funds.
                {beneficiary && (
                  <span className="block mt-1 text-blue-600 dark:text-blue-400">
                    Freelancer will see the updated milestone amount immediately.
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Total amount */}
              <div className="space-y-1.5">
                <Label htmlFor="add-total">Amount to Add (USDC)</Label>
                <Input
                  id="add-total"
                  type="number"
                  step="0.000001"
                  min="0"
                  placeholder="e.g. 5"
                  value={addTotal}
                  onChange={(e) => setAddTotal(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  New total: {(currentTotal + addTotalNum).toFixed(6)} USDC
                </p>
              </div>

              {/* Milestone allocation picker */}
              {milestones.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Allocate to Milestone</Label>
                  <div className="space-y-2 max-h-48 overflow-y-auto overflow-x-hidden pr-1">
                    {milestones.map((m) => {
                      const currentAmt = weiToUsdc(m.amount);
                      const selected = selectedAddMilestone === m.index;
                      return (
                        <button
                          key={m.index}
                          type="button"
                          onClick={() => setSelectedAddMilestone(m.index)}
                          className={`w-full text-left flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                            selected
                              ? "border-primary bg-primary/10 ring-1 ring-primary"
                              : "border-muted hover:border-primary/50"
                          }`}
                        >
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <div className="text-xs font-medium text-muted-foreground">
                              Milestone {m.index + 1}
                            </div>
                            <div className="text-sm truncate max-w-[260px]">{m.description || "—"}</div>
                          </div>
                          <div className="text-xs font-semibold whitespace-nowrap shrink-0 text-right">
                            {currentAmt.toFixed(4)} USDC
                            {selected && addTotalNum > 0 && (
                              <span className="block text-green-600 dark:text-green-400">
                                → {(currentAmt + addTotalNum).toFixed(4)}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Info box */}
              <div className="flex gap-2 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  Funds and the milestone amount are updated on-chain in the same transaction.
                </span>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddFunds} disabled={isSubmitting || addTotalNum <= 0}>
                {isSubmitting ? "Adding…" : "Add Funds"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Withdraw Funds Dialog ─────────────────────────────────────── */}
        <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <MinusCircle className="h-4 w-4" />
              Withdraw Funds
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-[min(480px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Withdraw Funds from Milestone</DialogTitle>
              <DialogDescription>
                Choose which milestone to reduce and how much to withdraw. Funds are returned to
                your wallet immediately.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Milestone picker */}
              {milestones.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Reduce from Milestone</Label>
                  <div className="space-y-2 max-h-48 overflow-y-auto overflow-x-hidden pr-1">
                    {milestones.map((m) => {
                      const currentAmt = weiToUsdc(m.amount);
                      const selected = selectedWithdrawMilestone === m.index;
                      return (
                        <button
                          key={m.index}
                          type="button"
                          onClick={() => setSelectedWithdrawMilestone(m.index)}
                          className={`w-full text-left flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                            selected
                              ? "border-primary bg-primary/10 ring-1 ring-primary"
                              : "border-muted hover:border-primary/50"
                          }`}
                        >
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <div className="text-xs font-medium text-muted-foreground">
                              Milestone {m.index + 1}
                            </div>
                            <div className="text-sm truncate max-w-[260px]">{m.description || "—"}</div>
                          </div>
                          <div className="text-xs font-semibold whitespace-nowrap shrink-0 text-right">
                            {currentAmt.toFixed(4)} USDC
                            {selected && withdrawTotalNum > 0 && (
                              <span className={`block ${withdrawTotalNum > currentAmt ? "text-red-500" : "text-amber-600 dark:text-amber-400"}`}>
                                → {Math.max(0, currentAmt - withdrawTotalNum).toFixed(4)}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Amount */}
              <div className="space-y-1.5">
                <Label htmlFor="withdraw-total">Amount to Withdraw (USDC)</Label>
                <Input
                  id="withdraw-total"
                  type="number"
                  step="0.000001"
                  min="0"
                  max={
                    selectedWithdrawMilestone !== null && milestones[selectedWithdrawMilestone]
                      ? weiToUsdc(milestones[selectedWithdrawMilestone].amount)
                      : currentTotal
                  }
                  placeholder="e.g. 2"
                  value={withdrawTotal}
                  onChange={(e) => setWithdrawTotal(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Remaining in escrow: {Math.max(0, currentTotal - withdrawTotalNum).toFixed(6)} USDC
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setWithdrawOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleWithdrawFunds}
                disabled={isSubmitting || withdrawTotalNum <= 0 || withdrawTotalNum > currentTotal}
              >
                {isSubmitting ? "Withdrawing…" : "Withdraw Funds"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Cancel Job ───────────────────────────────────────────────── */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" className="gap-2">
              <XCircle className="h-4 w-4" />
              Cancel Job
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                Cancel This Job?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This cancels the job and refunds all funds (including platform fees) to your wallet.
                This action cannot be undone. You can only cancel before a freelancer is assigned.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep Job</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleCancelJob}
                disabled={isSubmitting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isSubmitting ? "Cancelling…" : "Cancel Job"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <p className="text-xs text-muted-foreground mt-4">
        💡 Fund management is available until a freelancer is assigned to this job.
      </p>
    </Card>
  );
}
