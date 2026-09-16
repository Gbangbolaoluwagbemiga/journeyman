import { encodeJobId } from "@/lib/id-codec";
import { useState, useEffect, useRef } from "react";
import { useWriteContract } from "wagmi";
import { Card } from "@/components/ui/card";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { CONTRACTS } from "@/lib/web3/config";
import { isGraphConfigured, graphQuery } from "@/lib/graph/client";
import { GET_USER_ESCROWS, type UserEscrowsResponse } from "@/lib/graph/queries";
import { normalizeEscrow, dedupeEscrows, rpcMilestoneStatus } from "@/lib/graph/normalize";
import {
  cacheOriginalDescription,
  cacheOriginalDescriptions,
  clearRecoveryInFlight,
  getOriginalDescription,
  hasAttemptedRecovery,
  isRecoveryInFlight,
  markRecoveryAttempted,
  markRecoveryInFlight,
} from "@/lib/milestone-cache";

import {
  useNotifications,
  createEscrowNotification,
  createMilestoneNotification,
} from "@/contexts/notification-context";
import type { Escrow } from "@/lib/web3/types";
import {
  Wallet,
  FileText,
} from "lucide-react";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { PageActions } from "@/components/atelier/page-actions";
import { DashboardStats } from "@/components/dashboard/dashboard-stats";
import { EscrowCard } from "@/components/dashboard/escrow-card";
import { DashboardLoading } from "@/components/dashboard/dashboard-loading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

/**
 * `embedded` hides this page's own title so it can sit under My Jobs' tabs
 * without stacking two headings. The page is otherwise unchanged — it is 1,200
 * lines of working escrow management and the merge is not an excuse to rewrite
 * it.
 */
export default function DashboardPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { wallet, getContract } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const { addNotification } = useNotifications();
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const escrowsRef = useRef<Escrow[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`archived_escrows_${wallet.address ?? ""}`);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Keep ref in sync with state
  useEffect(() => {
    escrowsRef.current = escrows;
  }, [escrows]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "active" | "completed" | "disputed" | "archived"
  >("all");
  const [sortFilter, setSortFilter] = useState<"newest" | "oldest">("newest");
  const [expandedEscrow, setExpandedEscrow] = useState<string | null>(null);
  const [submittingMilestone, setSubmittingMilestone] = useState<string | null>(
    null
  );

  const getStatusFromNumber = (status: number): string => {
    switch (status) {
      case 0:
        return "pending";
      case 1:
        return "active";
      case 2:
        return "completed";
      case 3:
        return "refunded";
      case 4:
        return "disputed";
      case 5:
        return "expired";
      case 6:
        return "cancelled";
      default:
        return "pending";
    }
  };

  const calculateDaysLeft = (createdAt: number, duration: number): number => {
    const now = Date.now();
    // Duration is already in seconds from the contract, convert to milliseconds
    const projectEndTime = createdAt + duration * 1000;
    const daysLeft = Math.ceil((projectEndTime - now) / (24 * 60 * 60 * 1000));
    return Math.max(0, daysLeft); // Don't show negative days
  };

  const getDaysLeftMessage = (
    daysLeft: number
  ): { text: string; color: string; bgColor: string } => {
    if (daysLeft > 7) {
      return {
        text: `${daysLeft} days`,
        color: "text-red-700 dark:text-red-400",
        bgColor: "bg-red-50 dark:bg-red-900/20",
      };
    } else if (daysLeft > 0) {
      return {
        text: `${daysLeft} days`,
        color: "text-orange-700 dark:text-orange-400",
        bgColor: "bg-orange-50 dark:bg-orange-900/20",
      };
    } else {
      return {
        text: "Deadline passed",
        color: "text-red-700 dark:text-red-400",
        bgColor: "bg-red-100 dark:bg-red-900/30",
      };
    }
  };

  useEffect(() => {
    if (wallet.isConnected) {
      fetchUserEscrows();
    }
  }, [wallet.isConnected]);

  // Listen for escrow update events from MilestoneActions
  useEffect(() => {
    const handleEscrowUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceAddress?: string }>).detail;
      const sourceAddress = detail?.sourceAddress?.toLowerCase();
      const current = wallet.address?.toLowerCase();
      if (sourceAddress && current && sourceAddress === current) {
        // Ignore self-originated updates when source is known.
        return;
      }

      // Bypass subgraph (it lags behind the chain) and read directly from RPC.
      fetchUserEscrows(true, true);
    };

    window.addEventListener("escrowUpdated", handleEscrowUpdated);
    window.addEventListener("milestoneApproved", handleEscrowUpdated);
    window.addEventListener("milestoneSubmitted", handleEscrowUpdated);
    window.addEventListener("milestoneRejected", handleEscrowUpdated);
    window.addEventListener("disputeResolved", handleEscrowUpdated);

    return () => {
      window.removeEventListener("escrowUpdated", handleEscrowUpdated);
      window.removeEventListener("milestoneApproved", handleEscrowUpdated);
      window.removeEventListener("milestoneSubmitted", handleEscrowUpdated);
      window.removeEventListener("milestoneRejected", handleEscrowUpdated);
      window.removeEventListener("disputeResolved", handleEscrowUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  const fetchUserEscrows = async (isManualRefresh = false, forceRPC = false) => {
    // Use ref to get the most current escrows, not the stale closure value
    const previousEscrows = escrowsRef.current;
    const previousEscrowsCount = previousEscrows.length;

    // Don't set loading to true if we're refreshing after an operation - preserve UI
    if (isManualRefresh) {
      setIsRefreshing(true);
    } else if (previousEscrowsCount === 0) {
      // Only set loading if we don't have escrows yet (initial load)
      setLoading(true);
    }
    try {
      if (!wallet.isConnected || !wallet.address) {
        // Only clear escrows if we're doing an initial load, not a refresh
        if (!isManualRefresh && previousEscrowsCount === 0) {
          setEscrows([]);
        }
        setLoading(false);
        return;
      }

      // ── Try subgraph first (fast), fall back to multicall RPC ────────────
      // Skip subgraph on forced RPC refreshes (post-mutation) — the subgraph
      // lags 10-30 s behind the chain on testnet, so we'd read stale data.
      if (!forceRPC && isGraphConfigured()) {
        try {
          const data = await graphQuery<UserEscrowsResponse>(
            GET_USER_ESCROWS,
            { address: wallet.address.toLowerCase() },
          );
          const raw = dedupeEscrows(data.deposited ?? [], data.assigned ?? []);
          let normalized = raw.map((g) => normalizeEscrow(g, wallet.address ?? ""));

          // Subgraph doesn't index projectTitle/projectDescription (not in the EscrowCreated
          // event) and only creates Milestone entities on submission events — so pending jobs
          // have empty milestone arrays with 0 amounts. Enrich everything from RPC.
          const allIds = normalized
            .map((e) => parseInt(e.id, 10))
            .filter((id) => Number.isFinite(id));

          if (allIds.length > 0) {
            try {
              const { ContractService: CS } = await import("@/lib/web3/contract-service");
              const svc = new CS(CONTRACTS.ATELIER_ESCROW);
              const [rpcBatch, milestonesBatch] = await Promise.all([
                svc.getEscrowsBatch(allIds),
                svc.getMilestonesBatch(allIds),
              ]);
              normalized = normalized.map((e) => {
                const id = parseInt(e.id, 10);
                const rpc = rpcBatch[id];
                const rpcMs = milestonesBatch[id];
                const milestones = rpcMs && rpcMs.length > 0
                  ? rpcMs.map((m: any, idx: number) => {
                      const existing = e.milestones[idx];
                      const resolvedAtRaw = m.resolvedAt ? Number(m.resolvedAt) : 0;
                      const resolvedByRaw = m.resolvedBy && m.resolvedBy !== "0x0000000000000000000000000000000000000000" ? m.resolvedBy : undefined;
                      return {
                        description: existing?.description || m.description || "",
                        originalDescription: existing?.originalDescription,
                        amount: m.amount?.toString() || "0",
                        status: resolvedAtRaw > 0 ? "resolved" as const : (existing?.status ?? rpcMilestoneStatus(Number(m.status))),
                        submittedAt: existing?.submittedAt,
                        approvedAt: existing?.approvedAt,
                        proposedAmount: m.proposedAmount?.toString() || existing?.proposedAmount,
                        proposedDescription: m.proposedDescription || existing?.proposedDescription,
                        rejectionReason: m.rejectionReason || existing?.rejectionReason || undefined,
                        disputeReason: m.disputeReason || existing?.disputeReason || undefined,
                        resolvedAt: resolvedAtRaw > 0 ? resolvedAtRaw * 1000 : existing?.resolvedAt,
                        resolvedBy: resolvedByRaw || existing?.resolvedBy || undefined,
                      };
                    })
                  : e.milestones;
                // The subgraph's `status` can lag behind the chain — most visibly
                // right after a dispute resolves, since that's someone else's
                // transaction and this wallet has no live signal for it. `rpc` is
                // already fetched above for this same escrow, so just use it.
                const freshStatus: Escrow["status"] =
                  rpc?.status != null ? (getStatusFromNumber(Number(rpc.status)) as Escrow["status"]) : e.status;
                return {
                  ...e,
                  status: freshStatus,
                  projectTitle: rpc?.projectTitle || e.projectTitle || "",
                  projectDescription: rpc?.projectDescription || e.projectDescription || "",
                  totalAmount: rpc?.totalAmount != null ? rpc.totalAmount.toString() : e.totalAmount,
                  releasedAmount: rpc?.paidAmount != null ? rpc.paidAmount.toString() : e.releasedAmount,
                  milestones,
                };
              });
            } catch { /* non-critical — subgraph data still usable */ }
          }

          // Only trust the subgraph result if it returned data — an empty result
          // likely means the subgraph is indexing the old contract, so fall through
          // to the RPC scan which reads directly from the current deployment.
          if (normalized.length > 0) {
            setEscrows(normalized);
            return; // subgraph had data — skip RPC path
          }
          // subgraph returned 0 results — fall through to RPC scan
        } catch (graphErr) {
          console.warn("[dashboard] subgraph query failed, falling back to RPC:", graphErr);
        }
      }

      // ── RPC fallback (multicall) ──────────────────────────────────────────
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      const userEscrows: Escrow[] = [];
      const nowSeconds = Math.floor(Date.now() / 1000);

      // 1 RPC: get all escrow IDs for this wallet
      const escrowIds = await contractService.getUserEscrows(wallet.address);

      if (escrowIds.length === 0) {
        setEscrows([]);
        return;
      }

      // 1 multicall: fetch all escrow structs at once
      const escrowBatch = await contractService.getEscrowsBatch(escrowIds);
      // 1 multicall: fetch all milestones at once
      const milestonesBatch = await contractService.getMilestonesBatch(escrowIds);

      for (const i of escrowIds) {
        try {
          const escrowData = escrowBatch[i];

          if (!escrowData) {
            continue;
          }

          const isPayer =
            escrowData.depositor &&
            escrowData.depositor.toLowerCase().trim() ===
              wallet.address.toLowerCase().trim();
          const isBeneficiary =
            escrowData.beneficiary &&
            escrowData.beneficiary.toLowerCase().trim() ===
              wallet.address.toLowerCase().trim();

          if (isPayer || isBeneficiary) {
            /*
             * NOT a creation time — the chain does not store one.
             *
             * This was Date.now() and named "approx", and anything computing
             * `createdAt + duration` off it got today's date plus the time
             * remaining. The subgraph path fills the same field with the real
             * creation time, so the two loaders produced different answers for
             * the same job and a background refresh made the number flip
             * between them. Everything that matters now reads deadlineAt; this
             * stays only because the shape requires it.
             */
            const approxCreatedAt = Date.now();
            const deadlineSeconds = Number(escrowData.deadline ?? 0);
            const remainingSeconds = Math.max(0, deadlineSeconds - nowSeconds);
            const durationInSeconds = remainingSeconds;

            const milestonesData: any[] = milestonesBatch[i] ?? [];
            const milestones = milestonesData
              .map((m: any, milestoneIndex: number) => {
                try {
                  // Convert milestone status to number first (might be string enum or number)
                  let statusNumber = 0;
                  const rawStatus = m.status || m[2] || 0;

                  if (typeof rawStatus === "string") {
                    // Status is an enum string like "NotStarted", "Submitted", "Approved", etc.
                    switch (rawStatus.toLowerCase()) {
                      case "notstarted":
                      case "pending":
                        statusNumber = 0;
                        break;
                      case "submitted":
                        statusNumber = 1;
                        break;
                      case "approved":
                        statusNumber = 2;
                        break;
                      case "disputed":
                        statusNumber = 3;
                        break;
                      case "resolved":
                        statusNumber = 4;
                        break;
                      case "rejected":
                        statusNumber = 5;
                        break;
                      default:
                        statusNumber = 0;
                    }
                  } else if (typeof rawStatus === "number") {
                    statusNumber = rawStatus;
                  } else if (Array.isArray(rawStatus) && rawStatus.length > 0) {
                    // Status might be an enum array
                    const statusStr = rawStatus[0];
                    if (typeof statusStr === "string") {
                      switch (statusStr.toLowerCase()) {
                        case "notstarted":
                        case "pending":
                          statusNumber = 0;
                          break;
                        case "submitted":
                          statusNumber = 1;
                          break;
                        case "approved":
                          statusNumber = 2;
                          break;
                        case "disputed":
                          statusNumber = 3;
                          break;
                        case "resolved":
                          statusNumber = 4;
                          break;
                        case "rejected":
                          statusNumber = 5;
                          break;
                      }
                    } else if (typeof statusStr === "number") {
                      statusNumber = statusStr;
                    }
                  }

                  const statusMap: Record<
                    number,
                    | "pending"
                    | "submitted"
                    | "approved"
                    | "rejected"
                    | "disputed"
                    | "resolved"
                    | "proposal_pending"
                  > = {
                    0: "pending",           // NotStarted
                    1: "submitted",         // Submitted
                    2: "approved",          // Approved (also used for resolved disputes)
                    3: "rejected",          // Rejected
                    4: "disputed",          // Disputed
                    5: "proposal_pending",  // ProposalPending
                  };
                  
                  let status = statusMap[statusNumber] || "pending";
                  
                  // If milestone is approved AND has a resolvedAt timestamp, it was a resolved dispute
                  if (status === "approved" && m.resolvedAt && BigInt(m.resolvedAt) > 0n) {
                    status = "resolved";
                  }


                  // milestone timestamps are Unix seconds (from block.timestamp)
                  const submittedAt = m.submittedAt > 0 ? Number(m.submittedAt) * 1000 : undefined;
                  const approvedAt = m.approvedAt > 0 ? Number(m.approvedAt) * 1000 : undefined;
                  const resolvedAt = m.resolvedAt > 0 ? Number(m.resolvedAt) * 1000 : undefined;

                  const currentDescription = m.description || "";
                  if (status === "pending" && currentDescription) {
                    cacheOriginalDescription(i, milestoneIndex, currentDescription);
                  }
                  const originalDescription = getOriginalDescription(i, milestoneIndex);

                  return {
                    description: currentDescription,
                    requirements: m.requirements || originalDescription || undefined,
                    originalDescription,
                    amount: m.amount?.toString() || "0",
                    status,
                    submittedAt,
                    approvedAt,
                    disputeReason: m.disputeReason || undefined,
                    rejectionReason: m.rejectionReason || undefined,
                    resolvedAt,
                    resolvedBy: m.resolvedBy || undefined,
                    resolutionAmount: m.resolutionFreelancerAmount?.toString() || undefined,
                    resolutionClientAmount: m.resolutionClientAmount?.toString() || undefined,
                    resolutionReason: m.resolutionReason || undefined,
                    proposedAmount: m.proposedAmount?.toString() || undefined,
                    proposedDescription: m.proposedDescription || undefined,
                  };
                } catch (error) {
                  // Return a safe default milestone object if parsing fails
                  return {
                    description: m.description || "",
                    amount: m.amount?.toString() || "0",
                    status: "pending" as const,
                    submittedAt: undefined,
                    approvedAt: undefined,
                    disputeReason: undefined,
                    rejectionReason: undefined,
                  };
                }
              })
              .filter((m) => m !== null && m !== undefined);

            const deadlineAt = deadlineSeconds > 0 ? deadlineSeconds * 1000 : undefined;

            const escrow: Escrow = {
              id: i.toString(),
              payer: escrowData.depositor || "",
              beneficiary: escrowData.beneficiary || "",
              isClient: isPayer ? true : undefined,
              isFreelancer: isBeneficiary ? true : undefined,
              token: escrowData.token || "",
              totalAmount: escrowData.totalAmount?.toString() ?? "0",
              releasedAmount: escrowData.paidAmount?.toString() ?? "0",
              status: getStatusFromNumber(escrowData.status || 0) as
                | "pending"
                | "active"
                | "completed"
                | "disputed",
              createdAt: approxCreatedAt,
              duration: durationInSeconds,
              deadlineAt,
              milestones,
              projectTitle: escrowData.projectTitle || "",
              projectDescription: escrowData.projectDescription || "",
            };

            userEscrows.push(escrow);
          }
        } catch (error) {
          // Skip escrows that don't exist or user doesn't have access to
          continue;
        }
      }


      // If we had escrows before but now have 0, preserve existing escrows and log warning
      if (previousEscrowsCount > 0 && userEscrows.length === 0) {
        // Don't update escrows - keep what we had
        // This prevents the dashboard from going empty after operations
        return;
      }

      // Always update escrows if fetch was successful
      // The error handling in catch block will preserve escrows if fetch fails
      setEscrows(userEscrows);

      // Recover original milestone descriptions for escrows whose milestones
      // have already been submitted (so the snapshot path missed them). See
      // FreelancerPage for the same pattern.
      void (async () => {
        let anyRecovered = false;
        for (const escrow of userEscrows) {
          const needsRecovery = escrow.milestones.some(
            (m) => !m.originalDescription,
          );
          if (!needsRecovery) continue;
          if (hasAttemptedRecovery(escrow.id)) continue;
          if (isRecoveryInFlight(escrow.id)) continue;
          markRecoveryInFlight(escrow.id);
          try {
            const originals =
              await contractService.getOriginalMilestoneDescriptions(
                Number(escrow.id),
              );
            if (originals && originals.length > 0) {
              cacheOriginalDescriptions(escrow.id, originals);
              markRecoveryAttempted(escrow.id);
              anyRecovered = true;
            }
          } finally {
            clearRecoveryInFlight(escrow.id);
          }
        }
        if (anyRecovered) {
          setEscrows((prev) =>
            prev.map((esc) => ({
              ...esc,
              milestones: esc.milestones.map((m, idx) => ({
                ...m,
                originalDescription:
                  m.originalDescription ?? getOriginalDescription(esc.id, idx),
              })),
            })),
          );
        }
      })();
    } catch (error) {
      // Don't clear existing escrows on error - preserve what we have
      // Only show toast if we don't have any escrows yet
      if (escrows.length === 0) {
        toast({
          title: "Failed to load escrows",
          description: "Could not fetch your escrows from the blockchain",
          variant: "destructive",
        });
      } else {
        // If we have existing escrows, just log the error but don't show toast
        // This prevents clearing the UI when a refresh fails
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  const handleRefresh = () => {
    fetchUserEscrows(true, true); // always hit RPC on manual refresh
  };

  /*
   * WATCH FOR WHAT THE OTHER SIDE DOES.
   *
   * This page fetched once when the wallet connected and then listened only for
   * events its own tab dispatched. Everything the counterparty did was
   * invisible: a freelancer delivered a milestone and the client's dashboard
   * went on showing "pending" until they happened to reload. The one screen
   * whose entire job is to tell you when something needs your attention was the
   * one screen that never changed on its own.
   *
   * Straight to RPC rather than the subgraph, which lags ten to thirty seconds
   * on testnet — polling a stale source would just be a slower way to show the
   * wrong thing. Paused while the tab is hidden, because nobody is reading it.
   */
  const refreshRef = useRef(fetchUserEscrows);
  refreshRef.current = fetchUserEscrows;
  useEffect(() => {
    if (!wallet.isConnected) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refreshRef.current(false, true);
    }, 15_000);
    return () => clearInterval(id);
  }, [wallet.isConnected]);


  const disputeMilestone = async (escrowId: string, milestoneIndex: number) => {
    try {
      // SECURITY: Double-check that user is the depositor
      const escrow = escrows.find((e) => e.id === escrowId);
      if (
        !escrow ||
        escrow.payer.toLowerCase() !== wallet.address?.toLowerCase()
      ) {
        toast({
          title: "Access Denied",
          description: "Only the job creator can dispute milestones",
          variant: "destructive",
        });
        return;
      }

      setSubmittingMilestone(`${escrowId}-${milestoneIndex}`);
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      toast({
        title: "Disputing milestone...",
        description: "Please confirm the transaction in your wallet",
      });

      await cs.disputeMilestone({
        escrow_id: Number(escrowId),
        milestone_index: milestoneIndex,
        reason: "Disputed by client",
        disputer: wallet.address || "",
      }, writeContractAsync);

      toast({
        title: "Milestone Disputed",
        description: "A dispute has been opened for this milestone",
      });

      // Notify admin about the new dispute
      try {
        const ownerAddress = await cs.getOwner();
        if (ownerAddress) {
          addNotification(
            {
              type: "dispute",
              title: "New Dispute Raised",
              message: `${encodeJobId(escrowId)}, Milestone ${milestoneIndex}: Disputed by client`,
              actionUrl: `/admin`,
              data: { escrowId, milestoneIndex, reason: "Disputed by client" },
            },
            [ownerAddress],
          );
        }
      } catch (error) {
        console.error("Failed to notify admin:", error);
      }

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await fetchUserEscrows(true, true); // forceRPC: bypass subgraph lag after mutation
      } catch (refreshError: any) {
        toast({
          title: "Milestone Disputed",
          description:
            "Milestone was disputed, but failed to refresh data. Please refresh the page.",
          variant: "default",
        });
        // Don't throw - the dispute was successful, just the refresh failed
      }
    } catch (error: any) {
      toast({
        title: "Dispute Failed",
        description: error.message || "Failed to dispute milestone",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const startWork = async (escrowId: string) => {
    try {
      setSubmittingMilestone(escrowId);
      const { ContractService: CS2 } = await import("@/lib/web3/contract-service");
      const svc2 = new CS2(CONTRACTS.ATELIER_ESCROW);
      await svc2.startWork(Number(escrowId), wallet.address || "", writeContractAsync);
      toast({
        title: "Work Started",
        description: "You have started work on this escrow",
      });

      // Get freelancer address from escrow data
      const escrow = escrows.find((e) => e.id === escrowId);
      const payer = escrow?.payer;
      const beneficiary = escrow?.beneficiary;
      const current = wallet.address?.toLowerCase();
      const otherParty =
        current && payer?.toLowerCase() === current ? beneficiary : payer;

      // Notify the *other party* only (no self-notifications).
      if (otherParty) {
        addNotification(
          createEscrowNotification("work_started", escrowId, {
            projectTitle:
              escrows.find((e) => e.id === escrowId)?.projectDescription ||
              `Project #${escrowId}`,
            freelancerName:
              wallet.address!.slice(0, 6) + "..." + wallet.address!.slice(-4),
          }),
          [otherParty],
        );
      }

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await fetchUserEscrows();
    } catch (error) {
      toast({
        title: "Start Work Failed",
        description: "Could not start work. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const openDispute = async (escrowId: string) => {
    try {
      setSubmittingMilestone(escrowId);
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      await cs.disputeMilestone({
        escrow_id: Number(escrowId),
        milestone_index: 0,
        reason: "General dispute",
        disputer: wallet.address || "",
      }, writeContractAsync);

      toast({
        title: "Dispute Opened",
        description: "A dispute has been opened for this escrow",
      });

      // Notify admin about the new dispute
      try {
        const ownerAddress = await cs.getOwner();
        if (ownerAddress) {
          addNotification(
            {
              type: "dispute",
              title: "New Dispute Raised",
              message: `${encodeJobId(escrowId)}, Milestone 0: General dispute`,
              actionUrl: `/admin`,
              data: { escrowId, milestoneIndex: 0, reason: "General dispute" },
            },
            [ownerAddress],
          );
        }
      } catch (error) {
        console.error("Failed to notify admin:", error);
      }

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await fetchUserEscrows(true, true); // forceRPC: bypass subgraph lag after mutation
      } catch (refreshError: any) {
        toast({
          title: "Dispute Opened",
          description:
            "Dispute was opened, but failed to refresh data. Please refresh the page.",
          variant: "default",
        });
        // Don't throw - the dispute was successful, just the refresh failed
      }
    } catch (error: any) {
      toast({
        title: "Dispute Failed",
        description: "Could not open dispute. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const approveMilestone = async (escrowId: string, milestoneIndex: number) => {
    try {
      // SECURITY: Double-check that user is the depositor
      const escrow = escrows.find((e) => e.id === escrowId);
      if (
        !escrow ||
        escrow.payer.toLowerCase() !== wallet.address?.toLowerCase()
      ) {
        toast({
          title: "Access Denied",
          description: "Only the job creator can approve milestones",
          variant: "destructive",
        });
        return;
      }

      setSubmittingMilestone(`${escrowId}-${milestoneIndex}`);
      toast({
        title: "Approving milestone...",
        description: "Please confirm the transaction in your wallet",
      });

      const { ContractService: CS3 } = await import("@/lib/web3/contract-service");
      const svc3 = new CS3(CONTRACTS.ATELIER_ESCROW);
      await svc3.approveMilestone({ escrow_id: Number(escrowId), milestone_index: milestoneIndex, depositor: wallet.address }, writeContractAsync);

      // Transaction is already confirmed via waitForConfirmation in web3-context
      // Wait for tx confirmation
      // The transaction hash is returned after confirmation
      toast({
        title: "Milestone Approved!",
        description: "Payment has been sent to the freelancer",
      });

      // Get freelancer address from escrow data
      const freelancerAddress = escrow.beneficiary;

      // Notify freelancer only (no self-notifications).
      if (freelancerAddress) {
        addNotification(
          createMilestoneNotification("approved", escrowId, milestoneIndex, {
            clientName:
              wallet.address.slice(0, 6) + "..." + wallet.address.slice(-4),
            projectTitle: escrow.projectDescription || `Project #${escrowId}`,
          }),
          [freelancerAddress],
        );
      }

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Add debugging for payment tracking

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Refresh the escrow data without reloading the page
      // Use manual refresh flag to prevent showing loading screen
      try {
        await fetchUserEscrows(true, true); // forceRPC: bypass subgraph lag after mutation
      } catch (refreshError: any) {
        toast({
          title: "Milestone Approved",
          description:
            "Milestone was approved, but failed to refresh data. Please refresh the page.",
          variant: "default",
        });
        // Don't throw - the approval was successful, just the refresh failed
      }

      // Dispatch event to notify other components
      window.dispatchEvent(new CustomEvent("milestoneApproved"));
    } catch (error: any) {
      toast({
        title: "Approval Failed",
        description: error.message || "Failed to approve milestone",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const raiseOverdueDispute = async (escrowId: string, reason: string) => {
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);
      toast({
        title: "Raising overdue dispute…",
        description: "Please confirm the transaction in your wallet",
      });
      await cs.raiseOverdueDispute({
        escrow_id: Number(escrowId),
        requester: wallet.address || "",
        reason,
      }, writeContractAsync);
      toast({
        title: "Dispute submitted",
        description: "Arbiters have been notified and will review your case",
      });

      // Notify all authorized arbiters via the backend
      const escrow = escrows.find((e) => e.id === escrowId);
      try {
        const authorizedArbiters: string[] = []; // Arbiters not enumerable on-chain; notify via off-chain
        for (const arbAddr of authorizedArbiters) {
          addNotification(
            {
              type: "dispute",
              title: "Overdue Dispute Raised",
              message: `Project "${escrow?.projectDescription?.slice(0, 60) || `#${escrowId}`}" is overdue and needs arbitration`,
              actionUrl: `/admin?escrow=${escrowId}`,
              data: {
                escrowId,
                requester: wallet.address,
                reason,
              },
            },
            [arbAddr],
          );
        }
      } catch {
        /* arbiter fetch failed — non-critical */
      }

      await fetchUserEscrows(true, true); // forceRPC: bypass subgraph lag after mutation
    } catch (error: any) {
      toast({
        title: "Failed to raise dispute",
        description: error.message || "Transaction failed",
        variant: "destructive",
      });
    }
  };

  const extendDeadline = async (escrowId: string, extraDays: number) => {
    try {
      toast({
        title: "Extending deadline…",
        description: "Please confirm the transaction in your wallet",
      });
      const { ContractService: CS4 } = await import("@/lib/web3/contract-service");
      const svc4 = new CS4(CONTRACTS.ATELIER_ESCROW);
      await svc4.extendDeadline({
        escrow_id: Number(escrowId),
        extra_seconds: extraDays * 86400,
        depositor: wallet.address || "",
      }, writeContractAsync);
      toast({
        title: "Deadline extended",
        description: `Added ${extraDays} day${extraDays > 1 ? "s" : ""} to the project deadline`,
      });
      await fetchUserEscrows(true, true); // forceRPC: subgraph lags behind the new deadline
    } catch (error: any) {
      toast({
        title: "Failed to extend deadline",
        description: error.message || "Transaction failed",
        variant: "destructive",
      });
    }
  };

  const [reclaimingEscrowId, setReclaimingEscrowId] = useState<string | null>(null);

  const reclaimSurplus = async (escrowId: string) => {
    setReclaimingEscrowId(escrowId);
    try {
      toast({
        title: "Reclaiming surplus…",
        description: "Please confirm the transaction in your wallet",
      });
      await writeContractAsync({
        address: CONTRACTS.ATELIER_ESCROW as `0x${string}`,
        abi: (await import("@/lib/web3/AtelierABI.json")).default.abi,
        functionName: "emergencyRefundAfterDeadline",
        args: [BigInt(escrowId)],
      });
      toast({
        title: "Surplus reclaimed",
        description: "Unallocated funds have been returned to your wallet.",
      });
      await fetchUserEscrows(true, true); // forceRPC: bypass subgraph lag after mutation
    } catch (error: any) {
      let msg = error.message || "Transaction failed";
      if (msg.includes("EmergencyPeriodNotReached"))
        msg = "Emergency period not reached yet — wait until 30 days after the deadline expires.";
      toast({
        title: "Reclaim failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setReclaimingEscrowId(null);
    }
  };

  const archiveEscrow = (escrowId: string) => {
    const next = new Set(archivedIds);
    next.add(escrowId);
    setArchivedIds(next);
    try {
      localStorage.setItem(
        `archived_escrows_${wallet.address ?? ""}`,
        JSON.stringify([...next]),
      );
    } catch { /* non-fatal */ }
    toast({ title: "Archived", description: "Project hidden. View it under the Archived filter." });
  };

  const unarchiveEscrow = (escrowId: string) => {
    const next = new Set(archivedIds);
    next.delete(escrowId);
    setArchivedIds(next);
    try {
      localStorage.setItem(
        `archived_escrows_${wallet.address ?? ""}`,
        JSON.stringify([...next]),
      );
    } catch { /* non-fatal */ }
    toast({ title: "Unarchived", description: "Project restored to your dashboard." });
  };

  const rejectMilestone = async (
    escrowId: string,
    milestoneIndex: number,
    reason: string
  ) => {
    try {
      // SECURITY: Double-check that user is the depositor
      const escrow = escrows.find((e) => e.id === escrowId);
      if (
        !escrow ||
        escrow.payer.toLowerCase() !== wallet.address?.toLowerCase()
      ) {
        toast({
          title: "Access Denied",
          description: "Only the job creator can reject milestones",
          variant: "destructive",
        });
        return;
      }

      setSubmittingMilestone(`${escrowId}-${milestoneIndex}`);
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      toast({
        title: "Rejecting milestone...",
        description: "Please confirm the transaction in your wallet",
      });

      await cs.rejectMilestone({
        escrow_id: Number(escrowId),
        milestone_index: milestoneIndex,
        reason: reason,
        depositor: wallet.address || "",
      }, writeContractAsync);

      toast({
        title: "Milestone Rejected",
        description: "The freelancer has been notified and can resubmit",
      });

      // Dispatch event for milestone rejection
      window.dispatchEvent(new CustomEvent("milestoneRejected", {
        detail: {
          escrowId: Number(escrowId),
          milestoneIndex,
          reason,
          sourceAddress: wallet.address,
        }
      }));

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Refresh the escrow data without reloading the page
      // Use manual refresh flag to prevent showing loading screen
      try {
        await fetchUserEscrows(true, true); // forceRPC: bypass subgraph lag after mutation
      } catch (refreshError: any) {
        toast({
          title: "Milestone Rejected",
          description:
            "Milestone was rejected, but failed to refresh data. Please refresh the page.",
          variant: "default",
        });
        // Don't throw - the rejection was successful, just the refresh failed
      }
    } catch (error: any) {
      toast({
        title: "Rejection Failed",
        description: error.message || "Failed to reject milestone",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  if (!wallet.isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-mesh">
        <Card className="glass border-primary/20 p-12 text-center max-w-md">
          <Wallet className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-2xl font-bold mb-2">Wallet Not Connected</h2>
          <p className="text-muted-foreground mb-6">
            Please connect your wallet to view your escrows
          </p>
        </Card>
      </div>
    );
  }

  if (loading) {
    return <DashboardLoading isConnected={wallet.isConnected} />;
  }

  if (!wallet.isConnected) {
    return (
      <div className="min-h-screen py-12">
        <div className="container mx-auto px-4">
          <DashboardHeader />
          <Card className="glass border-primary/20 p-12 text-center max-w-md">
            <Wallet className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
            <h2 className="text-2xl font-bold mb-2">Connect Your Wallet</h2>
            <p className="text-muted-foreground">
              Connect your wallet to view your escrows and manage milestones.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen py-12">
        <div className="container mx-auto px-4">
          <DashboardHeader />
          <DashboardLoading isConnected={wallet.isConnected} />
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${embedded ? "" : "min-h-screen py-12"}`}>
      {/* Spinner overlay when refreshing */}
      {isRefreshing && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <RefreshCw className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Refreshing data...</p>
          </div>
        </div>
      )}
      <div className="container mx-auto px-4">
        {/* Embedded, this whole row collapses and Refresh is portalled up into
            My Jobs' tab row — otherwise it leaves a band of empty space with a
            button floating in it, between the tabs and the content, belonging
            to neither. */}
        <div className={embedded ? "" : "mb-8 flex items-start gap-4 justify-between"}>
          {!embedded && (
            <div>
              <h1 className="text-4xl md:text-5xl font-bold mb-2">Dashboard</h1>
              <p className="text-xl text-muted-foreground">
                Manage your escrows and track your projects
              </p>
            </div>
          )}
          <PageActions enabled={embedded}>
            <Button
              variant="outline"
              size="default"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-2"
            >
              <RefreshCw
                className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
              />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </PageActions>
        </div>

        <DashboardStats escrows={escrows} />

        {/* Search and Filters */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4 items-end">
          {/* Search Bar */}
          <div className="flex-1 min-w-0">
            <Input
              type="text"
              placeholder="Search projects by title or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full"
            />
          </div>

          {/* Status Filter */}
          <div className="w-full sm:w-[180px]">
            <Label htmlFor="status-filter" className="mb-2 block text-sm">
              Status
            </Label>
            <Select
              value={statusFilter}
              onValueChange={(value: any) => setStatusFilter(value)}
            >
              <SelectTrigger id="status-filter" className="w-full">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="disputed">Disputed</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Sort Filter */}
          <div className="w-full sm:w-[180px]">
            <Label htmlFor="sort-filter" className="mb-2 block text-sm">
              Sort
            </Label>
            <Select
              value={sortFilter}
              onValueChange={(value: any) => setSortFilter(value)}
            >
              <SelectTrigger id="sort-filter" className="w-full">
                <SelectValue placeholder="Newest First" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest First</SelectItem>
                <SelectItem value="oldest">Oldest First</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {escrows.length === 0 ? (
          <Card className="glass border-muted p-12 text-center">
            <FileText className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-50" />
            <h3 className="text-xl font-bold mb-2">No Escrows Found</h3>
            <p className="text-muted-foreground">
              You don't have any escrows yet. Create one to get started.
            </p>
          </Card>
        ) : (
          <div className="space-y-6">
            {escrows
              .filter((escrow) => {
                const isArchived = archivedIds.has(escrow.id);

                // Archived filter — show only archived
                if (statusFilter === "archived") return isArchived;

                // All other filters — hide archived and cancelled
                if (isArchived) return false;
                if (escrow.status === "cancelled") return false;

                const matchesStatus =
                  statusFilter === "all" || escrow.status === statusFilter;
                const matchesSearch =
                  !searchQuery ||
                  (escrow.projectDescription &&
                    escrow.projectDescription
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase()));

                return matchesStatus && matchesSearch;
              })
              .sort((a, b) => {
                if (sortFilter === "newest") {
                  return b.createdAt - a.createdAt;
                } else {
                  return a.createdAt - b.createdAt;
                }
              })
              .map((escrow, index) => (
                <EscrowCard
                  key={escrow.id}
                  escrow={escrow}
                  index={index}
                  expandedEscrow={expandedEscrow}
                  submittingMilestone={
                    submittingMilestone === escrow.id ? "true" : "false"
                  }
                  onToggleExpanded={() =>
                    setExpandedEscrow(
                      expandedEscrow === escrow.id ? null : escrow.id
                    )
                  }
                  onApproveMilestone={approveMilestone}
                  onRejectMilestone={(
                    escrowId: string,
                    milestoneIndex: number
                  ) => {
                    // For now, use empty reason - this should be handled by the component
                    rejectMilestone(
                      escrowId,
                      milestoneIndex,
                      "No reason provided"
                    );
                  }}
                  onDisputeMilestone={disputeMilestone}
                  onStartWork={startWork}
                  onDispute={openDispute}
                  calculateDaysLeft={calculateDaysLeft}
                  getDaysLeftMessage={getDaysLeftMessage}
                  onRaiseOverdueDispute={raiseOverdueDispute}
                  onExtendDeadline={extendDeadline}
                  onReclaimSurplus={reclaimSurplus}
                  reclaimingFunds={reclaimingEscrowId === escrow.id}
                  onArchive={archiveEscrow}
                  onUnarchive={statusFilter === "archived" ? unarchiveEscrow : undefined}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}




