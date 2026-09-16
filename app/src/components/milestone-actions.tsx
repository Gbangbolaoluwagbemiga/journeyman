import { encodeJobId } from "@/lib/id-codec";
import { useEffect, useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchDisputeResolutionNotes } from "@/lib/api";
import { useWeb3 } from "@/contexts/web3-context";
import {
  useNotifications,
  createMilestoneNotification,
} from "@/contexts/notification-context";
import { useToast } from "@/hooks/use-toast";
import { CONTRACTS } from "@/lib/web3/config";

import { AlertTriangle, CheckCircle2, Gavel, Loader2, Play, Send, XCircle } from "lucide-react";
import type { Milestone } from "@/lib/web3/types";
import { formatEth, formatTokenAmount } from "@/lib/utils";

interface MilestoneActionsProps {
  escrowId: string;
  milestoneIndex: number;
  milestone: Milestone;
  isPayer: boolean;
  isBeneficiary: boolean;
  escrowStatus: string;
  onSuccess: () => void;
  allMilestones?: Milestone[]; // Add all milestones for sequential validation
  showSubmitButton?: boolean; // New prop to control submit button visibility
  payerAddress?: string; // Client address for notifications
  beneficiaryAddress?: string; // Freelancer address for notifications
  escrowReleasedAmount?: string; // Total amount released in escrow (to determine dispute winner)
  escrowTotalAmount?: string; // Total escrow amount
  /**
   * True when Autopilot, not the client, decides this milestone.
   *
   * The client kept Approve / Reject / Dispute on a job they had handed over,
   * so both could act on the same submission — and the agent is already mid-
   * review when they see it. Whoever's transaction lands first wins, and the
   * other one reverts with a contract error nobody asked for.
   */
  managedByAgent?: boolean;
  /**
   * True while we do not yet know who manages this job.
   *
   * `manager === null` is both "the client runs it" and "we have not asked
   * yet", so gating on managedByAgent alone rendered Approve / Reject /
   * Dispute for a beat on every agent-run job before the answer arrived — the
   * wrong control, on the highest-stakes decision on the page, offered and
   * then withdrawn. Waiting is the honest state and it has to look like one.
   */
  managerLoading?: boolean;
}

export function MilestoneActions({
  escrowId,
  milestoneIndex,
  milestone,
  isPayer,
  isBeneficiary,
  escrowStatus,
  onSuccess,
  payerAddress,
  beneficiaryAddress,
  escrowReleasedAmount,
  escrowTotalAmount,
  managedByAgent = false,
  managerLoading = false,
}: MilestoneActionsProps) {
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { addNotification } = useNotifications();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionType, setActionType] = useState<
    | "start"
    | "submit"
    | "approve"
    | "reject"
    | "resubmit"
    | "dispute"
    | "resolve"
    | null
  >(null);
  const [disputeReason, setDisputeReason] = useState("");
  /*
   * The arbiter's written reasoning, from where both parties can read it.
   *
   * Only fetched for a milestone that actually went to arbitration — this is a
   * network call on a component that renders once per milestone, and a job with
   * five stages should not make five requests to learn there were no disputes.
   */
  const [sharedReason, setSharedReason] = useState<string | null>(null);
  useEffect(() => {
    if (milestone.status !== "resolved" && milestone.status !== "disputed") return;
    let live = true;
    void fetchDisputeResolutionNotes(escrowId)
      .then((notes) => {
        if (!live) return;
        const mine = notes.find((n) => Number(n.milestone_index) === Number(milestoneIndex));
        if (mine?.reason) setSharedReason(mine.reason);
      })
      .catch(() => {
        /* the local copy and the on-chain amounts still render */
      });
    return () => { live = false; };
  }, [escrowId, milestoneIndex, milestone.status]);

  const [resubmitMessage, setResubmitMessage] = useState("");

  // Helper functions
  const canApproveMilestone = () => {
    /* Not while the agent is deciding. Taking the job back restores these — the
       revoke is one click and is exactly the way out. */
    const canApprove =
      milestone.status === "submitted" &&
      isPayer &&
      escrowStatus === "active" &&
      !managedByAgent &&
      !managerLoading;
    return canApprove;
  };

  const canResubmitMilestone = () => {
    return (
      milestone.status === "rejected" &&
      isBeneficiary &&
      escrowStatus === "active"
    );
  };

  const isProjectDisputed =
    milestone.status === "disputed" || escrowStatus === "disputed";

  const openDialog = (type: typeof actionType) => {
    setActionType(type);
    setDialogOpen(true);
  };

  const handleAction = async () => {
    if (!actionType) return;

    setIsLoading(true);

    try {
      let txHash: `0x${string}` | undefined;

      switch (actionType) {
        case "start": {
          const { ContractService: StartCS } = await import("@/lib/web3/contract-service");
          const startSvc = new StartCS(CONTRACTS.ATELIER_ESCROW);
          txHash = await startSvc.startWork(Number(escrowId), wallet.address || "", writeContractAsync);
          break;
        }
        case "submit": {
          const { ContractService: SubCS } = await import("@/lib/web3/contract-service");
          const subSvc = new SubCS(CONTRACTS.ATELIER_ESCROW);
          txHash = await subSvc.submitMilestone({
            escrow_id: Number(escrowId),
            milestone_index: milestoneIndex,
            description: milestone.description,
            beneficiary: wallet.address || "",
          }, writeContractAsync);
          break;
        }
        case "approve":
          // Use ContractService instead of contract.send - it handles the correct format
          const { ContractService } = await import(
            "@/lib/web3/contract-service"
          );
          const contractService = new ContractService(
            CONTRACTS.ATELIER_ESCROW
          );
          txHash = await contractService.approveMilestone({
            escrow_id: Number(escrowId),
            milestone_index: milestoneIndex,
            depositor: wallet.address || "",
          }, writeContractAsync);
          break;
        case "reject":
          // Use ContractService instead of contract.send - it handles the correct format
          const { ContractService: RejectContractService } = await import(
            "@/lib/web3/contract-service"
          );
          const rejectContractService = new RejectContractService(
            CONTRACTS.ATELIER_ESCROW
          );
          txHash = await rejectContractService.rejectMilestone({
            escrow_id: Number(escrowId),
            milestone_index: milestoneIndex,
            reason: disputeReason,
            depositor: wallet.address || "",
          }, writeContractAsync);
          break;
        case "dispute":
          // Use ContractService instead of contract.send - it handles the correct format
          // Determine who can dispute: either payer (client) or beneficiary (freelancer)
          const disputerAddress = wallet.address || "";
          if (!disputerAddress) {
            throw new Error("Wallet address is required to dispute milestone");
          }
          const { ContractService: DisputeContractService } = await import(
            "@/lib/web3/contract-service"
          );
          const disputeContractService = new DisputeContractService(
            CONTRACTS.ATELIER_ESCROW
          );
          txHash = await disputeContractService.disputeMilestone({
            escrow_id: Number(escrowId),
            milestone_index: milestoneIndex,
            reason: disputeReason,
            disputer: disputerAddress,
          }, writeContractAsync);
          break;
        case "resubmit": {
          const { ContractService: ResubmitCS } = await import("@/lib/web3/contract-service");
          const resubmitCS = new ResubmitCS(CONTRACTS.ATELIER_ESCROW);
          txHash = await resubmitCS.submitMilestone({
            escrow_id: Number(escrowId),
            milestone_index: milestoneIndex,
            description: resubmitMessage || milestone.description,
            beneficiary: wallet.address || "",
          }, writeContractAsync);
          break;
        }
      }

      if (txHash) {
        // Wait for the transaction to be mined before refreshing UI
        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash: txHash });
        }

        const successMessages: Record<
          string,
          { title: string; description: string }
        > = {
          start: {
            title: "Work Started",
            description: "You have successfully started work on this escrow",
          },
          submit: {
            title: "Milestone Submitted",
            description: "Your milestone has been submitted for review",
          },
          approve: {
            title: "Milestone Approved",
            description: "Payment has been released to the freelancer",
          },
          reject: {
            title: "Milestone Rejected",
            description:
              "The milestone has been rejected. The freelancer can resubmit",
          },
          dispute: {
            title: "Dispute Created",
            description:
              "A dispute has been created and will be reviewed by an arbiter",
          },
          resubmit: {
            title: "Milestone Resubmitted",
            description: "Your milestone has been resubmitted for review",
          },
        };

        const message = successMessages[actionType] || {
          title: "Transaction Successful",
          description: "Your transaction has been submitted successfully",
        };

        toast({
          title: message.title,
          description: message.description,
        });

        // Emit global events so pages can refresh immediately after on-chain actions.
        // This avoids stale UI (especially with long staleTimes / manual fetch pages).
        window.dispatchEvent(
          new CustomEvent("escrowUpdated", {
            detail: {
              escrowId: Number(escrowId),
              milestoneIndex,
              action: actionType,
            },
          }),
        );
        if (actionType === "start") {
          window.dispatchEvent(
            new CustomEvent("workStarted", {
              detail: { escrowId: Number(escrowId) },
            }),
          );
        }
        if (actionType === "submit" || actionType === "resubmit") {
          window.dispatchEvent(
            new CustomEvent("milestoneSubmitted", {
              detail: { 
                escrowId: Number(escrowId), 
                milestoneIndex,
                sourceAddress: wallet.address // Add source address
              },
            }),
          );
        }
        if (actionType === "approve") {
          window.dispatchEvent(
            new CustomEvent("milestoneApproved", {
              detail: { 
                escrowId: Number(escrowId), 
                milestoneIndex,
                sourceAddress: wallet.address // Add source address
              },
            }),
          );
        }
        if (actionType === "approve") {
          // Notify freelancer that the milestone was approved
          if (beneficiaryAddress) {
            addNotification(
              createMilestoneNotification("approved", escrowId, milestoneIndex, {
                clientName: wallet.address
                  ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
                  : "Client",
              }),
              [beneficiaryAddress],
            );
          }
        }

        if (actionType === "reject") {
          window.dispatchEvent(
            new CustomEvent("milestoneRejected", {
              detail: { escrowId: Number(escrowId), milestoneIndex },
            }),
          );
          // Notify freelancer
          if (beneficiaryAddress) {
            addNotification(
              createMilestoneNotification("rejected", escrowId, milestoneIndex, {
                clientName: wallet.address
                  ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
                  : "Client",
                reason: disputeReason,
              }),
              [beneficiaryAddress],
            );
          }
        }

        if (actionType === "dispute") {
          // Dispatch event for dispute raised
          window.dispatchEvent(new CustomEvent("disputeRaised", {
            detail: {
              escrowId: Number(escrowId),
              milestoneIndex,
              clientAddress: payerAddress,
              freelancerAddress: beneficiaryAddress,
              reason: disputeReason,
            }
          }));

          // Notify the other party about the dispute
          const otherParty = isPayer ? beneficiaryAddress : payerAddress;
          if (otherParty) {
            addNotification(
              createMilestoneNotification("disputed", escrowId, milestoneIndex, {
                reason: disputeReason,
              }),
              [otherParty],
            );
          }

          // Notify admin/contract owner about the new dispute
          try {
            const { ContractService: AdminCS } = await import("@/lib/web3/contract-service");
            const adminCS = new AdminCS(CONTRACTS.ATELIER_ESCROW);
            const ownerAddress = await adminCS.getOwner();
            if (ownerAddress) {
              addNotification(
                {
                  type: "dispute",
                  title: "New Dispute Raised",
                  message: `${encodeJobId(escrowId)}, Milestone ${milestoneIndex}: ${disputeReason}`,
                  actionUrl: `/admin`,
                  data: { escrowId, milestoneIndex, reason: disputeReason },
                },
                [ownerAddress],
              );
            }
          } catch (error) {
            console.error("Failed to notify admin:", error);
          }
        }

        setDialogOpen(false);
        onSuccess();
      }
    } catch (error: any) {
      toast({
        title: "Transaction failed",
        description: error.message || "Failed to submit transaction",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Dialog content based on action type
  const dialogContent = {
    start: {
      title: "Start Work",
      description: "Are you sure you want to start work on this escrow?",
      confirmText: "Start Work",
    },
    submit: {
      title: "Submit Milestone",
      description: "Submit this milestone for client review and approval.",
      confirmText: "Submit Milestone",
    },
    approve: {
      title: "Approve Milestone",
      description:
        "Approve this milestone and release payment to the freelancer.",
      confirmText: "Approve & Release",
    },
    reject: {
      title: "Reject Milestone",
      description:
        "Reject this milestone. The freelancer can resubmit with improvements.",
      confirmText: "Reject Milestone",
    },
    dispute: {
      title: "Dispute Milestone",
      description:
        "Dispute this milestone. An arbiter will review and resolve the dispute.",
      confirmText: "Create Dispute",
    },
    resubmit: {
      title: "Resubmit Milestone",
      description:
        "Resubmit this milestone with improvements based on client feedback.",
      confirmText: "Resubmit Milestone",
    },
    resolve: {
      title: "Resolve Dispute",
      description: "Resolve this dispute and finalize the milestone outcome.",
      confirmText: "Resolve Dispute",
    },
  }[actionType || "submit"] || {
    title: "Confirm Action",
    description: "Are you sure you want to proceed?",
    confirmText: "Confirm",
  };

  const Icon =
    {
      start: Play,
      submit: Send,
      approve: CheckCircle2,
      reject: XCircle,
      dispute: Gavel,
      resubmit: Send,
      resolve: CheckCircle2,
    }[actionType || "submit"] || Send;

  return (
    <>
      <div className="flex flex-col gap-2">
        {/*
          THE AGENT HAS THIS ONE.

          Approve / Reject / Dispute stayed on screen after a hand-over, so the
          client and the agent could act on the same submission — and the agent
          is already mid-review by the time the client sees it. Whichever
          transaction lands first wins and the other reverts with a contract
          error nobody asked for.

          Said rather than hidden: an empty space under a submitted milestone
          reads as the app forgetting to render something.
        */}
        {/* Still finding out. Better than guessing wrong for a beat. */}
        {managerLoading && milestone.status === "submitted" && isPayer && !isProjectDisputed && (
          <div className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking who reviews this milestone…
          </div>
        )}

        {managedByAgent && milestone.status === "submitted" && isPayer && !isProjectDisputed && (
          <div className="rounded-lg border border-[var(--actor-agent)]/40 bg-[var(--actor-agent)]/10 px-3 py-2.5 text-sm">
            <div className="font-medium flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Autopilot is reviewing this delivery
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              It checks the work against every acceptance criterion and then
              approves and pays, or sends it back with the reasons. You will see
              the verdict here. Take the job back if you would rather decide
              this one yourself.
            </p>
          </div>
        )}

        {/* Approve Milestone - Only payer for submitted milestones (disabled if disputed) */}
        {canApproveMilestone() && !isProjectDisputed && (
          <Button
            onClick={() => openDialog("approve")}
            size="sm"
            variant="default"
            className="gap-2 bg-green-600 hover:bg-green-700 text-white w-full justify-center"
            disabled={isLoading}
          >
            <CheckCircle2 className="h-4 w-4" />
            {isLoading ? "Processing..." : "Approve"}
          </Button>
        )}

        {/* Reject Milestone - Only payer for submitted milestones (disabled if disputed) */}
        {canApproveMilestone() && !isProjectDisputed && (
          <Button
            onClick={() => openDialog("reject")}
            size="sm"
            variant="outline"
            className="gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300 w-full justify-center"
            disabled={isLoading}
          >
            <XCircle className="h-4 w-4" />
            {isLoading ? "Processing..." : "Reject"}
          </Button>
        )}

        {/* Dispute Milestone - Only payer for submitted milestones (disabled if disputed) */}
        {milestone.status === "submitted" &&
          isPayer &&
          !isProjectDisputed && (
            <Button
              onClick={() => openDialog("dispute")}
              size="sm"
              variant="destructive"
              className="gap-2 w-full justify-center"
              disabled={isLoading}
            >
              <Gavel className="h-4 w-4" />
              {isLoading ? "Processing..." : "Dispute"}
            </Button>
          )}

        {/* Approved Status - Show approved badge */}
        {milestone.status === "approved" && (
          <div className="flex items-center justify-center gap-2 text-green-600 py-2">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm font-medium">Approved</span>
          </div>
        )}

        {/* Rejected Status - Show rejected badge and resubmit button */}
        {milestone.status === "rejected" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-center gap-2 text-red-600 py-2">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm font-medium">Rejected</span>
            </div>
            {canResubmitMilestone() && (
              <Button
                onClick={() => openDialog("resubmit")}
                size="sm"
                variant="default"
                className="gap-2 w-full justify-center"
                disabled={isLoading}
                data-action="resubmit"
              >
                <Send className="h-4 w-4" />
                {isLoading ? "Processing..." : "Resubmit"}
              </Button>
            )}
          </div>
        )}

        {/* Disputed Status - Show disputed badge with reason */}
        {milestone.status === "disputed" && (
          <div className="flex flex-col gap-2 text-orange-600">
            <div className="flex items-center justify-center gap-2 py-2">
              <Gavel className="h-4 w-4" />
              <span className="text-sm font-medium">Disputed</span>
            </div>
            {milestone.disputeReason && (
              <div className="text-xs text-orange-700 bg-orange-50 p-2 rounded border border-orange-200">
                <strong>Reason:</strong> {milestone.disputeReason}
              </div>
            )}
          </div>
        )}

        {/* Resolved Status - Show resolved badge with winner info */}
        {milestone.status === "resolved" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-center gap-2 text-blue-600 py-2">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-sm font-medium">Dispute Resolved</span>
            </div>
            
            {/* Resolution Details */}
            {(() => {
              const milestoneAmount = Number(milestone.amount);
              const idStr = String(escrowId);
              const idxStr = String(milestoneIndex);

              /*
               * The shared note first, then this browser's own copy.
               *
               * localStorage is whoever resolved it, on whichever machine they
               * were using — which is why the other party could never read the
               * reasoning behind their own payment. The recorded note is the
               * same sentence, somewhere both sides can reach. The local keys
               * stay as a fallback for disputes settled before there was
               * anywhere to put it.
               */
              let resolutionReason =
                sharedReason ||
                localStorage.getItem(`resolution_${idStr}_${idxStr}`) ||
                localStorage.getItem(`resolution_${escrowId}_${milestoneIndex}`) ||
                milestone.resolutionReason ||
                null;

              // Resolution amounts: prefer on-milestone props, fall back to localStorage
              const lsFA = localStorage.getItem(`resolution_fa_${idStr}_${idxStr}`);
              const lsCA = localStorage.getItem(`resolution_ca_${idStr}_${idxStr}`);
              const freelancerAmount = milestone.resolutionAmount
                ? Number(milestone.resolutionAmount)
                : lsFA ? Number(lsFA) : 0;
              const clientAmount = milestone.resolutionClientAmount
                ? Number(milestone.resolutionClientAmount)
                : lsCA ? Number(lsCA) : 0;
              
              // Get the original dispute reason
              const disputeReason = milestone.disputeReason;
              
              // Get the token address from the escrow (we need to pass this as a prop)
              // For now, use address(0) which represents USDC on Arc Testnet
              const tokenAddress = "0x0000000000000000000000000000000000000000";
              
              return (
                <div className="space-y-2 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                  <div className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                    Admin Resolution Decision:
                  </div>
                  
                  {/* Original Dispute Reason */}
                  {disputeReason && (
                    <div className="p-2 bg-orange-50 dark:bg-orange-950 rounded border border-orange-200 dark:border-orange-800">
                      <p className="text-xs text-muted-foreground mb-1">Original Dispute Reason:</p>
                      <p className="text-sm text-orange-900 dark:text-orange-100">{disputeReason}</p>
                    </div>
                  )}
                  
                  {/* Admin's Resolution Reason */}
                  {resolutionReason && (
                    <div className="p-2 bg-white dark:bg-blue-950 rounded border border-blue-100 dark:border-blue-800">
                      <p className="text-xs text-muted-foreground mb-1">Admin's Resolution Reason:</p>
                      <p className="text-sm text-blue-900 dark:text-blue-100">{resolutionReason}</p>
                    </div>
                  )}
                  
                  {/* Money Split — only shown when amounts are known */}
                  {(freelancerAmount > 0 || clientAmount > 0) ? (
                    <>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between items-center p-2 bg-white dark:bg-blue-950 rounded border border-blue-100 dark:border-blue-800">
                          <span className="text-muted-foreground">Freelancer receives:</span>
                          <span className="font-semibold text-green-600 dark:text-green-400">
                            {formatTokenAmount(freelancerAmount, tokenAddress)}
                          </span>
                        </div>

                        <div className="flex justify-between items-center p-2 bg-white dark:bg-blue-950 rounded border border-blue-100 dark:border-blue-800">
                          <span className="text-muted-foreground">Client receives:</span>
                          <span className="font-semibold text-orange-600 dark:text-orange-400">
                            {formatTokenAmount(clientAmount, tokenAddress)}
                          </span>
                        </div>

                        <div className="flex justify-between items-center p-2 bg-white dark:bg-blue-950 rounded border border-blue-100 dark:border-blue-800">
                          <span className="text-muted-foreground">Total milestone:</span>
                          <span className="font-semibold text-blue-600 dark:text-blue-400">
                            {formatTokenAmount(milestoneAmount, tokenAddress)}
                          </span>
                        </div>
                      </div>

                      {/* Resolution Summary */}
                      <div className="pt-2 border-t border-blue-200 dark:border-blue-800">
                        {freelancerAmount > 0 && clientAmount > 0 ? (
                          <p className="text-xs text-blue-700 dark:text-blue-300">
                            ✅ <strong>Split Decision:</strong> The admin awarded {formatTokenAmount(freelancerAmount, tokenAddress)} to the freelancer and {formatTokenAmount(clientAmount, tokenAddress)} back to the client.
                          </p>
                        ) : freelancerAmount > 0 ? (
                          <p className="text-xs text-green-700 dark:text-green-300">
                            ✅ <strong>Freelancer Won:</strong> The admin awarded the full {formatTokenAmount(freelancerAmount, tokenAddress)} to the freelancer.
                          </p>
                        ) : (
                          <p className="text-xs text-orange-700 dark:text-orange-300">
                            ✅ <strong>Client Won:</strong> The admin refunded the full {formatTokenAmount(clientAmount, tokenAddress)} to the client.
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="pt-2 border-t border-blue-200 dark:border-blue-800">
                      <p className="text-xs text-blue-700 dark:text-blue-300">
                        ✅ <strong>Dispute resolved by admin.</strong> Check the escrow balance for payment details.
                      </p>
                    </div>
                  )}
                  
                  {/* Resolution Timestamp */}
                  {milestone.resolvedAt && (
                    <div className="text-xs text-muted-foreground pt-2 border-t border-blue-200 dark:border-blue-800">
                      Resolved on {new Date(milestone.resolvedAt).toLocaleDateString()} at {new Date(milestone.resolvedAt).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Duplicate dispute button removed */}
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="glass">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
                <Icon className="h-6 w-6 text-primary" />
              </div>
              <DialogTitle className="text-2xl">
                {dialogContent.title}
              </DialogTitle>
            </div>
            <DialogDescription className="text-base leading-relaxed">
              {dialogContent.description}
            </DialogDescription>
          </DialogHeader>

          <div className="bg-muted/50 rounded-lg p-4 my-4">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Escrow ID:</span>
                <span className="font-mono font-semibold">#{escrowId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Milestone:</span>
                <span className="font-semibold">{milestoneIndex + 1}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount:</span>
                <span className="font-bold text-primary">
                  {formatEth(milestone.amount)}
                </span>
              </div>
            </div>
          </div>

          {/* Reason input for dispute or reject action */}
          {(actionType === "dispute" || actionType === "reject") && (
            <div className="my-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Reason for {actionType === "dispute" ? "dispute" : "rejection"}{" "}
                (required)
              </label>
              <textarea
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder={`Please explain why you are ${
                  actionType === "dispute" ? "disputing" : "rejecting"
                } this milestone...`}
                className="w-full p-3 border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                rows={3}
                required
              />
              {!disputeReason.trim() && (
                <p className="text-sm text-red-600 mt-1">
                  Please provide a reason for the{" "}
                  {actionType === "dispute" ? "dispute" : "rejection"}
                </p>
              )}
            </div>
          )}

          {/* Rejection reason display and resubmit message for resubmit action */}
          {actionType === "resubmit" && (
            <div className="my-4 space-y-4">
              {/* Show rejection reason if available */}
              {milestone.rejectionReason && (
                <div>
                  <label className="block text-sm font-medium text-red-600 mb-2">
                    Rejection Reason
                  </label>
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                    {milestone.rejectionReason}
                  </div>
                </div>
              )}

              {/* Update message field */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Update Message
                </label>
                <textarea
                  value={resubmitMessage}
                  onChange={(e) => setResubmitMessage(e.target.value)}
                  placeholder="Describe the improvements you've made to address the client's feedback..."
                  className="w-full p-3 border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  rows={4}
                />
                <p className="text-xs text-gray-500 mt-1">
                  This message will be sent to the client along with your
                  resubmission.
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button onClick={handleAction} disabled={isLoading}>
              {isLoading ? "Processing..." : dialogContent.confirmText}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
