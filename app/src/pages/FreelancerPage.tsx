import { encodeJobId } from "@/lib/id-codec";
import { DeclineAssignment } from "@/components/atelier/decline-assignment";
import { ApplicantScores } from "@/components/atelier/applicant-scores";
import { useState, useEffect } from "react";
import { useWriteContract, usePublicClient, useSignMessage } from "wagmi";
import {
  uploadMilestoneFile,
  isApiConfigured,
  type UploadedFile,
} from "@/lib/api";
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
import { useWeb3 } from "@/contexts/web3-context";
import { CONTRACTS } from "@/lib/web3/config";
import { isGraphConfigured, graphQuery } from "@/lib/graph/client";
import { GET_USER_ESCROWS, type UserEscrowsResponse } from "@/lib/graph/queries";
import { normalizeEscrow, dedupeEscrows, rpcMilestoneStatus } from "@/lib/graph/normalize";

import {
  useNotifications,
  createEscrowNotification,
  createMilestoneNotification,
} from "@/contexts/notification-context";
// import { useSmartAccount } from "@/contexts/smart-account-context"; // Unused
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageActions } from "@/components/atelier/page-actions";
import { Textarea } from "@/components/ui/textarea";
// import { Input } from "@/components/ui/input"; // Unused
// import { Label } from "@/components/ui/label"; // Unused
import { useToast } from "@/hooks/use-toast";
// import { FreelancerHeader } from "@/components/freelancer/freelancer-header"; // Unused
import { FreelancerStats } from "@/components/freelancer/freelancer-stats";
// import { EscrowCard } from "@/components/freelancer/escrow-card"; // Unused
// import { FreelancerLoading } from "@/components/freelancer/freelancer-loading"; // Unused
import { Badge } from "@/components/ui/badge";
// import { Progress } from "@/components/ui/progress"; // Unused
// import {
//   Dialog,
//   DialogContent,
//   DialogDescription,
//   DialogFooter,
//   DialogHeader,
//   DialogTitle,
// } from "@/components/ui/dialog"; // Unused
// import { Alert, AlertDescription } from "@/components/ui/alert"; // Unused
// import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"; // Unused
import { EvidenceSubmissionButton } from "@/components/evidence-submission-button";
import { ViewEvidenceButton } from "@/components/view-evidence-button";
import { ChatDialog } from "@/components/chat/chat-dialog";
import { MilestoneNegotiation } from "@/components/milestone-negotiation";
import {
  FileText,
  User,
  DollarSign,
  CheckCircle,
  Calendar,
  Play,
  Clock,
  Star,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Scale,
  Archive,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { RefreshCw, MessageCircle as MessageCircleFreelancer } from "lucide-react";
import { Link } from "react-router-dom";
import { formatEth, formatTokenAmount } from "@/lib/utils";

interface Escrow {
  id: string;
  payer: string;
  beneficiary: string;
  token: string;
  totalAmount: string;
  releasedAmount: string;
  status: string;
  createdAt: number;
  duration: number;
  deadlineAt?: number;
  milestones: Milestone[];
  projectTitle?: string;
  projectDescription?: string;
  isOpenJob?: boolean;
  milestoneCount?: number;
}

interface Milestone {
  description: string;
  /** On-chain requirements field (new contract) */
  requirements?: string;
  /** @deprecated Cached original brief fallback for old contract */
  originalDescription?: string;
  amount: string;
  status: string;
  submittedAt?: number;
  approvedAt?: number;
  disputeReason?: string;
  rejectionReason?: string;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionAmount?: string;
}

function OverdueFreelancerBanner({
  escrowId,
  onRaiseDispute,
}: {
  escrowId: string;
  onRaiseDispute: (escrowId: string, reason: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className="mt-4 space-y-2.5">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-700">
        <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
        <p className="text-sm text-orange-700 dark:text-orange-400">
          The project deadline has passed. If the client is unresponsive or the situation is unfair, raise a dispute for arbiter review.
        </p>
      </div>
      {!show ? (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 w-full border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
          onClick={() => setShow(true)}
        >
          <Scale className="h-3.5 w-3.5" />
          Request Arbitration
        </Button>
      ) : (
        <div className="space-y-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700">
          <p className="text-xs font-medium text-red-700 dark:text-red-400">
            State your case — arbiters will review both sides fairly
          </p>
          <Textarea
            rows={3}
            placeholder="Describe the work you've done, why you deserve payment, and what resolution you're requesting..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="text-sm"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setShow(false); setReason(""); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!reason.trim()}
              onClick={() => {
                onRaiseDispute(escrowId, reason);
                setShow(false);
                setReason("");
              }}
            >
              Submit to Arbiters
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** See DashboardPage — same reason, same minimal change. */
export default function FreelancerPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { wallet, getContract } = useWeb3();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { addNotification } = useNotifications();
  // Arc EVM uses standard EOA wallets
  // const { executeTransaction, isSmartAccountReady } = useSmartAccount();
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`freelancer_archived_${wallet.address ?? ""}`);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  const [expandedEscrow, setExpandedEscrow] = useState<string | null>(null);
  const [chatOpenEscrowId, setChatOpenEscrowId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "active" | "completed" | "disputed" | "archived"
  >("all");
  const [sortFilter, setSortFilter] = useState<"newest" | "oldest">("newest");
  const [averageRating, setAverageRating] = useState<number>(0);
  const [ratingCount, setRatingCount] = useState<number>(0);
  const [badge, setBadge] = useState<
    "Beginner" | "Intermediate" | "Advanced" | "Expert" | null
  >("Beginner");
  const [escrowRatings, setEscrowRatings] = useState<
    Record<string, { rating: number; review: string }>
  >({});
  const [submittingMilestone, setSubmittingMilestone] = useState<string | null>(
    null
  );
  const [submittedMilestones, setSubmittedMilestones] = useState<Set<string>>(
    new Set()
  );
  const [approvedMilestones, setApprovedMilestones] = useState<Set<string>>(
    new Set()
  );
  const [selectedEscrowId, setSelectedEscrowId] = useState<string | null>(null);
  const [selectedMilestoneIndex, setSelectedMilestoneIndex] = useState<
    number | null
  >(null);
  const [milestoneDescriptions, setMilestoneDescriptions] = useState<
    Record<string, string>
  >({});
  /** Per-milestone attachment files that have been selected but not yet uploaded */
  const [milestoneFiles, setMilestoneFiles] = useState<Record<string, File | null>>({});
  /** Per-milestone upload state */
  const [milestoneUploading, setMilestoneUploading] = useState<Record<string, boolean>>({});
  /** Per-milestone already-uploaded file info */
  const [milestoneAttachments, setMilestoneAttachments] = useState<
    Record<string, { url: string; filename: string } | null>
  >({});
  const [showDisputeDialog, setShowDisputeDialog] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [resubmitDescription, setResubmitDescription] = useState("");
  const [showResubmitDialog, setShowResubmitDialog] = useState(false);
  const [selectedResubmitEscrow, setSelectedResubmitEscrow] = useState<
    string | null
  >(null);
  const [selectedResubmitMilestone, setSelectedResubmitMilestone] = useState<
    number | null
  >(null);
  const [resubmitFile, setResubmitFile] = useState<File | null>(null);
  const [resubmitUploading, setResubmitUploading] = useState(false);
  const [startingWorkId, setStartingWorkId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (wallet.isConnected) {
      fetchFreelancerEscrows();
    }
  }, [wallet.isConnected]);

  // Listen for escrow update events from milestone approvals
  useEffect(() => {
    const handleEscrowUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceAddress?: string }>).detail;
      const sourceAddress = detail?.sourceAddress?.toLowerCase();
      const current = wallet.address?.toLowerCase();
      if (sourceAddress && current && sourceAddress === current) {
        // Ignore self-originated updates when source is known.
        return;
      }

      // Single refresh per new cross-party notification — bypass subgraph (it lags behind).
      fetchFreelancerEscrows(true, true);
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

  const fetchFreelancerEscrows = async (isManualRefresh = false, forceRPC = false) => {
    if (isManualRefresh) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      if (!wallet.isConnected || !wallet.address) {
        return;
      }

      // ── Try subgraph first ────────────────────────────────────────────────
      if (!forceRPC && isGraphConfigured()) {
        try {
          const data = await graphQuery<UserEscrowsResponse>(
            GET_USER_ESCROWS,
            { address: wallet.address.toLowerCase() },
          );
          // Freelancer page: only escrows where wallet is beneficiary
          const addr = wallet.address ?? "";
          const raw = dedupeEscrows(data.deposited ?? [], data.assigned ?? []).filter(
            (g) => g.beneficiary?.toLowerCase() === addr.toLowerCase(),
          );
          let normalized = raw.map((g) => normalizeEscrow(g, addr));

          // Subgraph doesn't index title/description and has no milestone amounts at creation.
          // Enrich everything from RPC via one multicall pair.
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
                const freshStatus = rpc?.status != null ? getStatusFromNumber(Number(rpc.status)) : e.status;
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
            } catch { /* non-critical */ }
          }

          // Only trust the subgraph if it returned data — empty means it's
          // indexing the old contract; fall through to RPC scan instead.
          if (normalized.length > 0) {
            setEscrows(normalized as any);
            return;
          }
        } catch (graphErr) {
          console.warn("[freelancer] subgraph query failed, falling back to RPC:", graphErr);
        }
      }

      // ── RPC fallback ──────────────────────────────────────────────────────
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      const nowSeconds = Math.floor(Date.now() / 1000);
      const freelancerEscrows: Escrow[] = [];

      // 1 RPC: all escrow IDs for this wallet (depositor + beneficiary)
      const escrowIds = await contractService.getUserEscrows(wallet.address);

      if (escrowIds.length === 0) {
        setEscrows([]);
        return;
      }

      // 1 multicall: all escrow structs
      const escrowBatch = await contractService.getEscrowsBatch(escrowIds);
      // 1 multicall: all milestones
      const milestonesBatch = await contractService.getMilestonesBatch(escrowIds);

      for (const i of escrowIds) {
        try {
          const escrowData = escrowBatch[i];

          if (!escrowData) {
            continue;
          }

          const isBeneficiary =
            escrowData.beneficiary &&
            escrowData.beneficiary.toLowerCase().trim() ===
              wallet.address.toLowerCase().trim();

          if (isBeneficiary) {
            const approxCreatedAt = Date.now();
            const deadlineSeconds = Number(escrowData.deadline ?? 0);
            const remainingSeconds = Math.max(0, deadlineSeconds - nowSeconds);
            const durationInSeconds = remainingSeconds;

            const milestonesData: any[] = milestonesBatch[i] ?? [];

            const allMilestones = milestonesData.map(
              (m: any, index: number) => {
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


                // milestone timestamps are Unix seconds from block.timestamp
                const submittedAt = m.submittedAt > 0 ? Number(m.submittedAt) * 1000 : undefined;
                const approvedAt = m.approvedAt > 0 ? Number(m.approvedAt) * 1000 : undefined;

                // Track milestone states for submission prevention
                const milestoneKey = `${i}-${index}`;
                if (status === "approved") {
                  setApprovedMilestones(
                    (prev) => new Set([...prev, milestoneKey])
                  );
                } else if (status === "submitted") {
                  setSubmittedMilestones(
                    (prev) => new Set([...prev, milestoneKey])
                  );
                }

                const currentDescription = m.description || "";
                // Snapshot the original brief while the milestone is still
                // NotStarted — once submitted, the contract overwrites it.
                if (status === "pending" && currentDescription) {
                  cacheOriginalDescription(i, index, currentDescription);
                }
                const originalDescription = getOriginalDescription(i, index);

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
                  resolvedAt: m.resolvedAt && Number(m.resolvedAt) > 0 ? Number(m.resolvedAt) * 1000 : undefined,
                  resolvedBy: m.resolvedBy && m.resolvedBy !== "0x0000000000000000000000000000000000000000" ? m.resolvedBy : undefined,
                  proposedAmount: m.proposedAmount?.toString() || undefined,
                  proposedDescription: m.proposedDescription || undefined,
                };
              }
            );

            // Convert contract data to our Escrow type
            const statusNumber = escrowData.status || 0;
            const statusString = getStatusFromNumber(statusNumber);

            const deadlineAtFL = deadlineSeconds > 0 ? deadlineSeconds * 1000 : undefined;

            const escrow: Escrow = {
              id: i.toString(),
              payer: escrowData.depositor || "",
              beneficiary: escrowData.beneficiary || "",
              token: escrowData.token || "",
              totalAmount: escrowData.totalAmount?.toString() ?? "0",
              releasedAmount: escrowData.paidAmount?.toString() ?? "0",
              status: statusString,
              createdAt: approxCreatedAt,
              duration: durationInSeconds,
              deadlineAt: deadlineAtFL,
              milestones: allMilestones,
              projectTitle: escrowData.projectTitle || "",
              projectDescription: escrowData.projectDescription || "",
              isOpenJob: false,
              milestoneCount: allMilestones.length,
            };

            freelancerEscrows.push(escrow);
          }
        } catch (error) {
          continue;
        }
      }

      setEscrows(freelancerEscrows);

      // Recover original milestone descriptions for any escrow where the
      // freelancer has already submitted (so the cache snapshot path missed
      // them). One getLogs+getTransaction per escrow, gated by a
      // localStorage sentinel so we don't refetch each render.
      void (async () => {
        let anyRecovered = false;
        for (const escrow of freelancerEscrows) {
          const needsRecovery = escrow.milestones.some(
            (m) => !m.originalDescription,
          );
          if (!needsRecovery) continue;
          // Skip if we've already cached + sentineled it, or another concurrent
          // effect is mid-recovery for the same escrow.
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
          // Re-hydrate `originalDescription` from the freshly populated cache
          // without re-fetching everything from chain.
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

      // Fetch badge and rating for the freelancer
      if (wallet.address) {
        try {
          const badgeData = await contractService.getBadge(wallet.address);
          setBadge(badgeData as "Expert" | "Advanced" | "Intermediate" | "Beginner" | null);

          const ratingData = await contractService.getAverageRating(
            wallet.address
          );
          // averageX100 = 450 means 4.50; divide by 100 for display
          setAverageRating(ratingData.averageX100 / 100);
          setRatingCount(ratingData.count);
        } catch (error) {
        }
      }

      // Fetch ratings for completed escrows
      const ratings: Record<string, { rating: number; review: string }> = {};
      for (const escrow of freelancerEscrows) {
        if (escrow.status === "completed") {
          try {
            const rating = await contractService.getRating(
              Number.parseInt(escrow.id, 10),
              wallet.address || undefined
            );
            if (rating && (rating as any).score) {
              ratings[escrow.id] = {
                rating: (rating as any).score,
                review: (rating as any).review || "",
              };
            }
          } catch (error) {
          }
        }
      }
      setEscrowRatings(ratings);

      // Update submitted milestones based on current data
      const currentSubmittedMilestones = new Set<string>();
      freelancerEscrows.forEach((escrow) => {
        escrow.milestones.forEach((milestone, index) => {
          // Mark as submitted if milestone is submitted, approved, or has been processed
          if (
            milestone.status === "submitted" ||
            milestone.status === "approved" ||
            milestone.submittedAt ||
            milestone.approvedAt
          ) {
            currentSubmittedMilestones.add(`${escrow.id}-${index}`);
          }
        });
      });
      setSubmittedMilestones(currentSubmittedMilestones);
    } catch (error) {
      toast({
        title: "Failed to load escrows",
        description:
          "Could not fetch your assigned escrows from the blockchain",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  const handleRefresh = () => {
    fetchFreelancerEscrows(true);
  };

  const archiveEscrow = (escrowId: string) => {
    const next = new Set(archivedIds);
    next.add(escrowId);
    setArchivedIds(next);
    try {
      localStorage.setItem(
        `freelancer_archived_${wallet.address ?? ""}`,
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
        `freelancer_archived_${wallet.address ?? ""}`,
        JSON.stringify([...next]),
      );
    } catch { /* non-fatal */ }
    toast({ title: "Unarchived", description: "Project restored to your dashboard." });
  };

  const startWork = async (escrowId: string) => {
    setStartingWorkId(escrowId);
    try {
      if (!wallet.address) {
        toast({
          title: "Error",
          description:
            "Wallet address not found. Please reconnect your wallet.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Starting work...",
        description: "Submitting transaction to start work on this escrow",
      });

      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      await cs.startWork(Number(escrowId), wallet.address, writeContractAsync);

      toast({
        title: "Work started!",
        description: "You can now submit milestones for this project",
      });

      // Get client address from escrow data
      const escrow = escrows.find((e) => e.id === escrowId);
      const clientAddress = escrow?.payer;

      // Notify the client only (no self-notifications).
      if (clientAddress) {
        addNotification(
          createEscrowNotification("work_started", escrowId, {
            projectTitle:
              escrows.find((e) => e.id === escrowId)?.projectTitle ||
              `Project #${escrowId}`,
            freelancerName:
              wallet.address!.slice(0, 6) + "..." + wallet.address!.slice(-4),
          }),
          [clientAddress],
        );
      }

      // Wait a moment for blockchain state to update
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Refresh escrows
      await fetchFreelancerEscrows(true, true);
    } catch (error: any) {
      const errorMessage = error.message || "";

      if (
        errorMessage.includes("1102") ||
        errorMessage.includes("InvalidEscrowStatus") ||
        errorMessage.includes("1103") ||
        errorMessage.includes("WorkAlreadyStarted")
      ) {
        toast({
          title: "Work Already Started",
          description: "Work has already been started on this escrow.",
        });
        await fetchFreelancerEscrows(true, true);
      } else if (
        errorMessage.includes("User rejected") ||
        errorMessage.includes("user rejected") ||
        errorMessage.includes("4001") ||
        error.code === 4001
      ) {
        toast({
          title: "Transaction Cancelled",
          description: "You rejected the transaction in your wallet.",
          variant: "destructive",
        });
      } else if (
        errorMessage.includes("Disconnected from MetaMask") ||
        errorMessage.includes("Premature close") ||
        error.code === "UNPREDICTABLE_GAS_LIMIT"
      ) {
        toast({
          title: "Wallet Disconnected",
          description: "Please refresh the page and reconnect your wallet.",
          variant: "destructive",
        });
      } else if (errorMessage.includes("Only beneficiary")) {
        toast({
          title: "Not Authorized",
          description: "Only the assigned freelancer can start work on this escrow.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Failed to Start Work",
          description: "Something went wrong. Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setStartingWorkId(null);
    }
  };

  const submitMilestone = async (escrowId: string, milestoneIndex: number) => {
    const milestoneKey = `${escrowId}-${milestoneIndex}`;
    const baseDescription = milestoneDescriptions[milestoneKey] || "";

    // Upload any pending file attachment before submitting.
    // Keep a local reference so we can use it immediately without waiting
    // for the React state update cycle.
    let localAttachment = milestoneAttachments[milestoneKey] ?? null;
    const pendingFile = milestoneFiles[milestoneKey];
    if (pendingFile && isApiConfigured() && !localAttachment && wallet.address) {
      try {
        setMilestoneUploading((prev) => ({ ...prev, [milestoneKey]: true }));
        toast({ title: "Uploading attachment…", description: pendingFile.name });
        const uploaded: UploadedFile = await uploadMilestoneFile(
          pendingFile,
          escrowId,
          milestoneIndex,
          wallet.address,
          signMessageAsync,
        );
        localAttachment = { url: uploaded.url, filename: uploaded.filename };
        setMilestoneAttachments((prev) => ({
          ...prev,
          [milestoneKey]: localAttachment!,
        }));
        setMilestoneFiles((prev) => ({ ...prev, [milestoneKey]: null }));
      } catch (uploadErr: any) {
        toast({
          title: "File upload failed",
          description: uploadErr.message || "Could not upload attachment",
          variant: "destructive",
        });
        setMilestoneUploading((prev) => ({ ...prev, [milestoneKey]: false }));
        return;
      } finally {
        setMilestoneUploading((prev) => ({ ...prev, [milestoneKey]: false }));
      }
    }

    // Build the final description synchronously using the local reference.
    const description = localAttachment
      ? `${baseDescription}\n\n[Attachment: ${localAttachment.filename}](${localAttachment.url})`.trim()
      : baseDescription;

    // Keep UI state in sync too (non-blocking)
    if (localAttachment) {
      setMilestoneDescriptions((prev) => ({ ...prev, [milestoneKey]: description }));
    }

    // Check if milestone has already been submitted
    if (submittedMilestones.has(milestoneKey)) {
      toast({
        title: "Milestone already submitted",
        description:
          "This milestone has already been submitted and cannot be submitted again",
        variant: "destructive",
      });
      return;
    }

    // Check if milestone has already been approved
    if (approvedMilestones.has(milestoneKey)) {
      toast({
        title: "Milestone already approved",
        description:
          "This milestone has already been approved and cannot be resubmitted",
        variant: "destructive",
      });
      return;
    }

    // Check if this is the correct milestone to submit (sequential order)
    const escrow = escrows.find((e) => e.id === escrowId);
    if (escrow) {
      // Find the current milestone that should be submitted
      let expectedMilestoneIndex = -1;

      for (let i = 0; i < escrow.milestones.length; i++) {
        const milestone = escrow.milestones[i];
        const milestoneKey = `${escrowId}-${i}`;

        // Check if this milestone is pending and can be submitted
        if (
          milestone.status === "pending" &&
          !submittedMilestones.has(milestoneKey) &&
          !approvedMilestones.has(milestoneKey)
        ) {
          // For the first milestone, it can always be submitted if pending
          if (i === 0) {
            expectedMilestoneIndex = i;
            break;
          }

          // For subsequent milestones, check if the previous one is approved
          const previousMilestone = escrow.milestones[i - 1];
          const previousMilestoneKey = `${escrowId}-${i - 1}`;

          // Check if previous milestone is approved
          const isPreviousApproved =
            previousMilestone &&
            (previousMilestone.status === "approved" ||
              approvedMilestones.has(previousMilestoneKey));

          // Check if there are any submitted milestones before this one that aren't approved
          let hasUnapprovedSubmitted = false;
          for (let j = 0; j < i; j++) {
            const prevMilestone = escrow.milestones[j];
            const prevMilestoneKey = `${escrowId}-${j}`;
            const isPrevSubmitted =
              prevMilestone.status === "submitted" ||
              submittedMilestones.has(prevMilestoneKey);
            const isPrevApproved =
              prevMilestone.status === "approved" ||
              approvedMilestones.has(prevMilestoneKey);

            if (isPrevSubmitted && !isPrevApproved) {
              hasUnapprovedSubmitted = true;
              break;
            }
          }

          // Only allow submission if previous milestone is approved AND no submitted milestones are pending
          if (isPreviousApproved && !hasUnapprovedSubmitted) {
            expectedMilestoneIndex = i;
            break;
          }
        }
      }

      // Check if the milestone being submitted is the expected one
      if (expectedMilestoneIndex !== milestoneIndex) {
        if (expectedMilestoneIndex === -1) {
          toast({
            title: "No milestone available for submission",
            description:
              "All milestones are either completed or in progress. Please wait for the current milestone to be approved.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Wrong milestone sequence",
            description: `You can only submit milestone ${
              expectedMilestoneIndex + 1
            } at this time. Please complete the previous milestones first.`,
            variant: "destructive",
          });
        }
        return;
      }
    }

    // Additional check: Get the current milestone status from contract
    try {
      const { ContractService: MilCS } = await import("@/lib/web3/contract-service");
      const milCS = new MilCS(CONTRACTS.ATELIER_ESCROW);
      const milestones: any[] = await milCS.getMilestones(Number(escrowId)) as any[];

      if (milestones && milestones.length > milestoneIndex) {
        const milestone = milestones[milestoneIndex];
        const status = Number(milestone?.status ?? 0);
        if (milestone && status > 0 && status !== 3 /* Rejected */) {
          toast({
            title: "Milestone already processed",
            description: `This milestone has already been ${status === 2 ? "approved" : "submitted"} and cannot be submitted again`,
            variant: "destructive",
          });
          return;
        }
      }
    } catch (error) {}

    // Validate milestone description from input field
    if (!description?.trim()) {
      toast({
        title: "Description required",
        description: "Please provide a description of your work",
        variant: "destructive",
      });
      return;
    }

    try {
      if (!wallet.address) {
        toast({
          title: "Error",
          description:
            "Wallet address not found. Please reconnect your wallet.",
          variant: "destructive",
        });
        return;
      }

      setSubmittingMilestone(`${escrowId}-${milestoneIndex}`);

      toast({
        title: "Submitting milestone...",
        description: "Submitting transaction to submit your milestone",
      });

      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      await cs.submitMilestone({
        escrow_id: Number(escrowId),
        milestone_index: milestoneIndex,
        description: description,
        beneficiary: wallet.address,
      }, writeContractAsync);

      // Transaction is already confirmed via waitForConfirmation in web3-context
      // Wait for tx confirmation
      // The transaction hash is returned after confirmation
      toast({
        title: "Milestone submitted!",
        description: "Your milestone has been submitted for review",
      });

      // Get client address from escrow data
      const escrow = escrows.find((e) => e.id === escrowId);
      const clientAddress = escrow?.payer;

      // Notify the client only (no self-notifications).
      if (clientAddress) {
        addNotification(
          createMilestoneNotification("submitted", escrowId, milestoneIndex, {
            freelancerName:
              wallet.address!.slice(0, 6) + "..." + wallet.address!.slice(-4),
            projectTitle: escrow?.projectTitle || `Project #${escrowId}`,
          }),
          [clientAddress],
        );
      }

      // Mark this milestone as submitted to prevent double submission
      const milestoneKey = `${escrowId}-${milestoneIndex}`;
      setSubmittedMilestones((prev) => new Set([...prev, milestoneKey]));

      // Clear form and attachments
      setMilestoneDescriptions((prev) => {
        const updated = { ...prev };
        delete updated[milestoneKey];
        return updated;
      });
      setMilestoneAttachments((prev) => {
        const updated = { ...prev };
        delete updated[milestoneKey];
        return updated;
      });
      setMilestoneFiles((prev) => {
        const updated = { ...prev };
        delete updated[milestoneKey];
        return updated;
      });
      setSelectedEscrowId(null);

      // Refresh escrows
      await fetchFreelancerEscrows(true, true);

      // Dispatch event to notify other components
      window.dispatchEvent(new CustomEvent("milestoneSubmitted", {
        detail: { 
          escrowId: Number(escrowId), 
          milestoneIndex,
          sourceAddress: wallet.address // Add source to prevent self-refresh
        }
      }));
    } catch (error) {
      toast({
        title: "Failed to submit milestone",
        description: "Could not submit your milestone",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const resubmitMilestone = async (
    escrowId: string,
    milestoneIndex: number,
    description: string
  ) => {
    if (!description.trim()) {
      toast({
        title: "Description required",
        description: "Please describe the improvements you've made",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmittingMilestone(`${escrowId}-${milestoneIndex}`);

      // Optionally upload an attachment first, then append the link to the
      // description so the client sees it in the on-chain description blob.
      let finalDescription = description.trim();
      if (resubmitFile && isApiConfigured() && wallet.address) {
        try {
          setResubmitUploading(true);
          toast({
            title: "Uploading attachment…",
            description: resubmitFile.name,
          });
          const uploaded: UploadedFile = await uploadMilestoneFile(
            resubmitFile,
            escrowId,
            milestoneIndex,
            wallet.address,
            signMessageAsync,
          );
          finalDescription = `${finalDescription}\n\n[Attachment: ${uploaded.filename}](${uploaded.url})`;
        } catch (uploadErr: any) {
          toast({
            title: "File upload failed",
            description: uploadErr?.message || "Could not upload attachment",
            variant: "destructive",
          });
          setSubmittingMilestone(null);
          setResubmitUploading(false);
          return;
        } finally {
          setResubmitUploading(false);
        }
      }

      toast({
        title: "Resubmitting milestone...",
        description: "Submitting transaction to resubmit your milestone",
      });

      // Use ContractService resubmitMilestone for rejected milestones
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      const resubmitHash = await contractService.resubmitMilestone({
        escrow_id: Number(escrowId),
        milestone_index: milestoneIndex,
        description: finalDescription,
        beneficiary: wallet.address || "",
      }, writeContractAsync);

      // Wait for the transaction to be mined so RPC reflects the new state
      if (publicClient && resubmitHash) {
        await publicClient.waitForTransactionReceipt({ hash: resubmitHash });
      }

      toast({
        title: "Milestone resubmitted!",
        description: "Your milestone has been resubmitted for client review",
      });

      // Get client address from escrow data
      const escrow = escrows.find((e) => e.id === escrowId);
      const clientAddress = escrow?.payer;

      // Add notification for milestone resubmission (notify the client)
      addNotification(
        createMilestoneNotification("submitted", escrowId, milestoneIndex, {
          freelancerName:
            wallet.address!.slice(0, 6) + "..." + wallet.address!.slice(-4),
          projectTitle: escrow?.projectTitle || `Project #${escrowId}`,
        }),
        clientAddress ? [clientAddress] : undefined // Notify the client
      );

      // Clear form and close dialog
      setResubmitDescription("");
      setResubmitFile(null);
      setShowResubmitDialog(false);
      setSelectedResubmitEscrow(null);
      setSelectedResubmitMilestone(null);

      // Force RPC refresh — subgraph lags behind the chain
      await fetchFreelancerEscrows(true, true);

      // Dispatch event to notify other components
      window.dispatchEvent(new CustomEvent("milestoneResubmitted"));
    } catch (error) {
      toast({
        title: "Failed to resubmit milestone",
        description: "Could not resubmit your milestone",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const openDispute = async (
    escrowId: string,
    milestoneIndex: number,
    reason: string
  ) => {
    if (!reason.trim()) {
      toast({
        title: "Reason required",
        description: "Please provide a reason for the dispute",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmittingMilestone(`${escrowId}-${milestoneIndex}`);

      toast({
        title: "Opening dispute...",
        description: "Submitting transaction to open dispute",
      });

      // Use ContractService instead of contract.send
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      await contractService.disputeMilestone({
        escrow_id: Number(escrowId),
        milestone_index: milestoneIndex,
        reason: reason,
        disputer: wallet.address || "",
      }, writeContractAsync);

      toast({
        title: "Dispute Opened!",
        description: "Your dispute has been opened successfully",
      });

      // Add notification for dispute opening
      addNotification(
        createMilestoneNotification("disputed", escrowId, milestoneIndex, {
          reason: reason,
          freelancerName:
            wallet.address!.slice(0, 6) + "..." + wallet.address!.slice(-4),
        })
      );

      // Notify admin about the new dispute
      try {
        const ownerAddress = await contractService.getOwner();
        if (ownerAddress) {
          addNotification(
            {
              type: "dispute",
              title: "New Dispute Raised",
              message: `${encodeJobId(escrowId)}, Milestone ${milestoneIndex}: ${reason}`,
              actionUrl: `/admin`,
              data: { escrowId, milestoneIndex, reason },
            },
            [ownerAddress],
          );
        }
      } catch (error) {
        console.error("Failed to notify admin:", error);
      }

      // Refresh escrows
      await fetchFreelancerEscrows(true, true);
    } catch (error) {
      toast({
        title: "Failed to open dispute",
        description: "Could not open dispute for this milestone",
        variant: "destructive",
      });
    } finally {
      setSubmittingMilestone(null);
    }
  };

  const raiseOverdueDispute = async (escrowId: string, reason: string) => {
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);
      toast({
        title: "Raising overdue dispute…",
        description: "Please confirm the transaction in your wallet",
      });
      await contractService.raiseOverdueDispute({
        escrow_id: Number(escrowId),
        requester: wallet.address || "",
        reason,
      }, writeContractAsync);
      toast({
        title: "Dispute submitted",
        description: "Arbiters have been notified and will review both sides fairly",
      });

      // Notify arbiters (arbiter list not enumerable on-chain)
      const escrow = escrows.find((e) => e.id === escrowId);
      try {
        const authorizedArbiters: string[] = [];
        for (const arbAddr of authorizedArbiters) {
          addNotification(
            {
              type: "dispute",
              title: "Overdue Dispute — Freelancer",
              message: `Freelancer raised a dispute on "${escrow?.projectTitle?.slice(0, 50) || `Project #${escrowId}`}"`,
              actionUrl: `/admin?escrow=${escrowId}`,
              data: { escrowId, requester: wallet.address, reason },
            },
            [arbAddr],
          );
        }
        // Notify client too
        if (escrow?.payer) {
          addNotification(
            {
              type: "dispute",
              title: "Overdue Dispute Raised",
              message: `A freelancer raised a dispute on your project "${escrow?.projectTitle?.slice(0, 50) || `#${escrowId}`}"`,
              actionUrl: `/dashboard?escrow=${escrowId}`,
              data: { escrowId, reason },
            },
            [escrow.payer],
          );
        }
      } catch { /* non-critical */ }

      await fetchFreelancerEscrows(true, true);
    } catch (error: any) {
      toast({
        title: "Failed to raise dispute",
        description: error.message || "Transaction failed",
        variant: "destructive",
      });
    }
  };

  const getStatusFromNumber = (
    status: number
  ): "pending" | "active" | "completed" | "disputed" | "cancelled" | "refunded" | "expired" => {
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

  const getMilestoneStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-muted text-muted-foreground";
      case "submitted":
        return "bg-yellow-100 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200";
      case "approved":
        return "bg-green-100 dark:bg-green-800 text-green-800 dark:text-green-200";
      case "rejected":
        return "bg-red-100 dark:bg-red-800 text-red-800 dark:text-red-200";
      case "disputed":
        return "bg-red-100 dark:bg-red-800 text-red-800 dark:text-red-200";
      case "resolved":
        return "bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "inprogress":
        return "bg-blue-100 text-blue-800";
      case "released":
        return "bg-green-100 text-green-800";
      case "completed":
        return "bg-green-100 text-green-800";
      case "submitted":
        return "bg-blue-100 text-blue-800";
      case "approved":
        return "bg-green-100 text-green-800";
      case "resolved":
        return "bg-purple-100 text-purple-800";
      case "disputed":
        return "bg-red-100 text-red-800";
      case "terminated":
        return "bg-muted text-muted-foreground";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const formatAmount = (amount: string) => {
    return formatEth(amount);
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

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  if (!wallet.isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Connect Wallet</CardTitle>
            <CardDescription>
              Please connect your wallet to view your freelancer dashboard
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    /* bg-gray-50/dark:bg-gray-900 was hardcoded here, which is why this page
       read as a slightly different product from the rest of the app — it
       ignored the theme tokens every other surface uses. */
    <div className={embedded ? "" : "min-h-screen"}>
      <div className={`container mx-auto px-4 ${embedded ? "" : "py-8"}`}>
        <div className={embedded ? "flex items-center gap-2" : "mb-8 flex items-start gap-4 justify-between"}>
          {!embedded && (
            <div>
              <h1 className="text-3xl font-bold mb-2">Freelancer Dashboard</h1>
              <p className="text-muted-foreground">
                Manage your assigned projects and track your earnings
              </p>
            </div>
          )}
          {/* See DashboardPage — same reason, same portal. */}
          <PageActions enabled={embedded}>
            <Link to="/messages">
              <Button variant="outline" size="default" className="flex items-center gap-2">
                <MessageCircleFreelancer className="h-4 w-4" />
                <span className="hidden sm:inline">Messages</span>
              </Button>
            </Link>
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

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : escrows.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                No assigned projects
              </h3>
              <p className="text-muted-foreground text-center">
                You don't have any assigned projects yet. Check the jobs page to
                find open opportunities.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Stats Section */}
            <FreelancerStats
              escrows={escrows}
              averageRating={averageRating}
              ratingCount={ratingCount}
              badge={badge ?? undefined}
            />

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

            {/* Projects Section */}
            <div className="grid gap-6">
              {escrows
                .filter((escrow) => {
                  const isArchived = archivedIds.has(escrow.id);

                  // Archived filter — show only archived
                  if (statusFilter === "archived") return isArchived;

                  // All other filters — hide archived
                  if (isArchived) return false;

                  const matchesStatus =
                    statusFilter === "all" || escrow.status === statusFilter;
                  const matchesSearch =
                    !searchQuery ||
                    (escrow.projectDescription ?? "")
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase());

                  return matchesStatus && matchesSearch;
                })
                .sort((a, b) => {
                  if (sortFilter === "newest") {
                    return b.createdAt - a.createdAt;
                  } else {
                    return a.createdAt - b.createdAt;
                  }
                })
                .map((escrow) => (
                  <motion.div
                    key={escrow.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <Card className="bg-card border-border">
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle className="flex items-center gap-2 text-foreground">
                              <User className="h-5 w-5" />
                              {escrow.projectTitle ||
                                (escrow.projectDescription
                                  ? escrow.projectDescription.length > 50
                                    ? escrow.projectDescription.substring(
                                        0,
                                        50
                                      ) + "..."
                                    : escrow.projectDescription
                                  : `Project #${escrow.id}`)}
                            </CardTitle>
                            <CardDescription className="mt-1 text-muted-foreground">
                              {escrow.projectDescription &&
                              (!escrow.projectTitle ||
                                escrow.projectDescription.length > 50)
                                ? escrow.projectDescription
                                : `Project ID: #${escrow.id}`}
                            </CardDescription>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge
                              className={getStatusColor(
                                escrow.milestones.some(
                                  (m) =>
                                    m.status === "disputed" ||
                                    m.status === "rejected"
                                )
                                  ? "terminated"
                                  : escrow.status
                              )}
                            >
                              {escrow.milestones.some(
                                (m) =>
                                  m.status === "disputed" ||
                                  m.status === "rejected"
                              )
                                ? "terminated"
                                : escrow.status}
                            </Badge>
                            {escrow.payer && wallet.address && isApiConfigured() && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 text-xs"
                                onClick={() => setChatOpenEscrowId(escrow.id)}
                                title="Message client"
                              >
                                <MessageCircleFreelancer className="h-3.5 w-3.5" />
                                Message
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setExpandedEscrow(
                                  expandedEscrow === escrow.id
                                    ? null
                                    : escrow.id
                                )
                              }
                              className="cursor-pointer"
                            >
                              {expandedEscrow === escrow.id ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4 mb-6">
                          <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                            <DollarSign className="h-5 w-5 text-green-600 dark:text-green-400" />
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Total Value
                              </p>
                              <p className="font-semibold text-green-700 dark:text-green-400">
                                {formatAmount(escrow.totalAmount)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                            <CheckCircle className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Released
                              </p>
                              <p className="font-semibold text-blue-700 dark:text-blue-400">
                                {formatAmount(escrow.releasedAmount)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                            <Calendar className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Created
                              </p>
                              <p className="font-semibold text-purple-700 dark:text-purple-400">
                                {formatDate(escrow.createdAt)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                            <FileText className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Milestones
                              </p>
                              <p className="font-semibold text-orange-700 dark:text-orange-400">
                                {escrow.milestoneCount ||
                                  escrow.milestones.length}{" "}
                                total
                              </p>
                            </div>
                          </div>
                          {(escrow.status === "pending" || escrow.status === "active") && (
                          <div
                            className={`flex items-center gap-2 p-3 rounded-lg ${(() => {
                              const daysLeft = calculateDaysLeft(
                                escrow.createdAt,
                                escrow.duration
                              );
                              const message = getDaysLeftMessage(daysLeft);
                              return message.bgColor;
                            })()}`}
                          >
                            <Clock className="h-5 w-5 text-red-600 dark:text-red-400" />
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Days Left
                              </p>
                              <p
                                className={`font-semibold ${(() => {
                                  const daysLeft = calculateDaysLeft(
                                    escrow.createdAt,
                                    escrow.duration
                                  );
                                  const message = getDaysLeftMessage(daysLeft);
                                  return message.color;
                                })()}`}
                              >
                                {(() => {
                                  const daysLeft = calculateDaysLeft(
                                    escrow.createdAt,
                                    escrow.duration
                                  );
                                  const message = getDaysLeftMessage(daysLeft);
                                  return message.text;
                                })()}
                              </p>
                            </div>
                          </div>
                          )}
                          {escrow.status === "completed" &&
                            escrowRatings[escrow.id] && (
                              <div className="flex items-center gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                                <Star className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                                <div>
                                  <p className="text-sm text-muted-foreground">
                                    Client Rating
                                  </p>
                                  <p className="font-semibold text-yellow-700 dark:text-yellow-400 flex items-center gap-1">
                                    {Array.from({ length: 5 }, (_, i) => (
                                      <Star
                                        key={i}
                                        className={`h-4 w-4 ${
                                          i < escrowRatings[escrow.id].rating
                                            ? "fill-yellow-400 text-yellow-400"
                                            : "text-muted-foreground/40"
                                        }`}
                                      />
                                    ))}
                                    <span className="ml-1">
                                      {escrowRatings[escrow.id].rating}/5
                                    </span>
                                  </p>
                                </div>
                              </div>
                            )}
                        </div>

                        {/* Archive / Unarchive — settled escrows only */}
                        {(escrow.status === "completed" ||
                          escrow.status === "cancelled" ||
                          escrow.status === "refunded" ||
                          escrow.status === "expired") && (
                          <div className="flex justify-end mt-2">
                            {statusFilter === "archived" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-muted-foreground hover:text-foreground gap-1.5"
                                onClick={() => unarchiveEscrow(escrow.id)}
                                title="Restore this project to your dashboard"
                              >
                                <Archive className="h-3.5 w-3.5" />
                                Unarchive
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-muted-foreground hover:text-foreground gap-1.5"
                                onClick={() => archiveEscrow(escrow.id)}
                                title="Hide this project from your dashboard"
                              >
                                <Archive className="h-3.5 w-3.5" />
                                Archive
                              </Button>
                            )}
                          </div>
                        )}

                        {/* Milestones - Compact Design */}
                        {expandedEscrow === escrow.id && (
                          <div className="mb-6">
                            <h4 className="font-semibold text-foreground mb-3">
                              Milestones (
                              {escrow.milestoneCount ||
                                escrow.milestones.length}{" "}
                              total)
                            </h4>

                            {/* Milestone Progress */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                              {escrow.milestones.map((milestone, index) => {
                                const milestoneKey = `${escrow.id}-${index}`;
                                const isApproved =
                                  milestone.status === "approved" ||
                                  approvedMilestones.has(milestoneKey);
                                const isSubmitted =
                                  milestone.status === "submitted" ||
                                  submittedMilestones.has(milestoneKey);
                                const isPending =
                                  milestone.status === "pending" &&
                                  !submittedMilestones.has(milestoneKey) &&
                                  !approvedMilestones.has(milestoneKey);

                                // Determine if this is the current milestone that can be submitted
                                let isCurrent = false;
                                let isBlocked = false;
                                if (isPending) {
                                  // For the first milestone, it can always be current if pending
                                  if (index === 0) {
                                    isCurrent = true;
                                  } else {
                                    // For subsequent milestones, check if the previous one is approved
                                    const previousMilestone =
                                      escrow.milestones[index - 1];
                                    const previousMilestoneKey = `${escrow.id}-${
                                      index - 1
                                    }`;

                                    // Check if previous milestone is approved
                                    const isPreviousApproved =
                                      previousMilestone &&
                                      (previousMilestone.status ===
                                        "approved" ||
                                        approvedMilestones.has(
                                          previousMilestoneKey
                                        ));

                                    // Check if there are any submitted milestones before this one that aren't approved
                                    let hasUnapprovedSubmitted = false;
                                    for (let j = 0; j < index; j++) {
                                      const prevMilestone =
                                        escrow.milestones[j];
                                      const prevMilestoneKey = `${escrow.id}-${j}`;
                                      const isPrevSubmitted =
                                        prevMilestone.status === "submitted" ||
                                        submittedMilestones.has(
                                          prevMilestoneKey
                                        );
                                      const isPrevApproved =
                                        prevMilestone.status === "approved" ||
                                        approvedMilestones.has(
                                          prevMilestoneKey
                                        );

                                      if (isPrevSubmitted && !isPrevApproved) {
                                        hasUnapprovedSubmitted = true;
                                        break;
                                      }
                                    }

                                    // Only allow submission if previous milestone is approved AND no submitted milestones are pending
                                    if (
                                      isPreviousApproved &&
                                      !hasUnapprovedSubmitted
                                    ) {
                                      isCurrent = true;
                                    } else if (hasUnapprovedSubmitted) {
                                      isBlocked = true;
                                    }
                                  }
                                }

                                return (
                                  <div
                                    key={index}
                                    className={`p-4 rounded-lg border-2 ${
                                      isApproved
                                        ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                                        : isSubmitted
                                          ? "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800"
                                          : isCurrent
                                            ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
                                            : isBlocked
                                              ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
                                              : "bg-muted/40 border-border"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="font-medium text-sm text-foreground">
                                        Milestone {index + 1}
                                      </span>
                                      <div className="flex gap-1">
                                        {isCurrent && (
                                          <Badge className="bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200">
                                            Current
                                          </Badge>
                                        )}
                                        {isBlocked && (
                                          <Badge className="bg-red-100 dark:bg-red-800 text-red-800 dark:text-red-200">
                                            Blocked
                                          </Badge>
                                        )}
                                        <Badge
                                          className={getMilestoneStatusColor(
                                            milestone.status
                                          )}
                                        >
                                          {milestone.status}
                                        </Badge>
                                      </div>
                                    </div>

                                    {/* Client Requirements — on-chain `requirements` field (new contract)
                                        or cached `originalDescription` (old contract fallback). */}
                                    {(() => {
                                      const reqText =
                                        milestone.requirements ||
                                        milestone.originalDescription ||
                                        (milestone.status === "pending" ? milestone.description : "");
                                      if (
                                        !reqText ||
                                        reqText.includes("To be defined") ||
                                        reqText === `Milestone ${index + 1}`
                                      ) {
                                        return null;
                                      }
                                      return (
                                        <div className="text-xs text-muted-foreground mb-2">
                                          <span className="font-medium">
                                            Requirements:
                                          </span>
                                          <p className="mt-1 whitespace-pre-wrap">
                                            {reqText}
                                          </p>
                                        </div>
                                      );
                                    })()}

                                    {/* Freelancer's submission response — shown when description exists and differs from requirements */}
                                    {milestone.description &&
                                      milestone.status !== "pending" &&
                                      (milestone.requirements
                                        ? true
                                        : milestone.originalDescription
                                          ? milestone.description !== milestone.originalDescription
                                          : false) && (
                                        <div className="text-xs text-blue-700 dark:text-blue-300 mb-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
                                          <span className="font-medium">
                                            Submission Response:
                                          </span>
                                          <p className="mt-1 whitespace-pre-wrap wrap-break-word">
                                            {milestone.description}
                                          </p>
                                        </div>
                                      )}

                                    <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                                      {formatAmount(milestone.amount)}
                                    </div>

                                    {/* Show rejected status if milestone is rejected */}
                                    {milestone.status === "rejected" && (
                                      <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                                        <div className="flex items-center gap-2 mb-2">
                                          <Badge className="bg-red-100 dark:bg-red-800 text-red-800 dark:text-red-200">
                                            Rejected - Needs Improvement
                                          </Badge>
                                        </div>

                                        {/* Display feedback directly */}
                                        {milestone.disputeReason && (
                                          <div className="mb-3 p-2 bg-red-100 dark:bg-red-800/30 rounded border border-red-200 dark:border-red-700">
                                            <p className="text-xs font-medium text-red-800 dark:text-red-200 mb-1">
                                              Client Feedback:
                                            </p>
                                            <p className="text-sm text-red-700 dark:text-red-300">
                                              {milestone.disputeReason}
                                            </p>
                                          </div>
                                        )}

                                        <p className="text-sm text-red-700 dark:text-red-300 mb-3">
                                          This milestone was rejected by the
                                          client. Please review the feedback
                                          above and resubmit with improvements.
                                        </p>

                                        <div className="flex flex-wrap gap-2">
                                          <Button
                                            size="sm"
                                            className="bg-red-600 hover:bg-red-700 text-white"
                                            onClick={() => {
                                              setSelectedResubmitEscrow(
                                                escrow.id
                                              );
                                              setSelectedResubmitMilestone(
                                                index
                                              );
                                              setResubmitDescription("");
                                              setShowResubmitDialog(true);
                                            }}
                                          >
                                            Resubmit Work
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="gap-1.5 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                                            onClick={() => {
                                              setSelectedEscrowId(escrow.id);
                                              setSelectedMilestoneIndex(index);
                                              setDisputeReason("");
                                              setShowDisputeDialog(true);
                                            }}
                                          >
                                            <Scale className="h-3.5 w-3.5" />
                                            Raise Dispute
                                          </Button>
                                        </div>
                                      </div>
                                    )}

                                    {/* Show milestone negotiation component for pending milestones */}
                                    {milestone.status === "pending" && (
                                      <div className="mt-3">
                                        <MilestoneNegotiation
                                          escrowId={escrow.id}
                                          milestoneIndex={index}
                                          milestone={milestone}
                                          isFreelancer={true}
                                          isClient={false}
                                          totalBudget={escrow.totalAmount}
                                          onUpdate={() => fetchFreelancerEscrows()}
                                        />
                                      </div>
                                    )}

                                    {/* Show proposal pending status for freelancers */}
                                    {milestone.status === "proposal_pending" && (
                                      <div className="mt-3 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                                        <div className="flex items-center gap-2">
                                          <Clock className="h-4 w-4 text-yellow-500" />
                                          <span className="text-sm text-yellow-700 dark:text-yellow-300 font-medium">
                                            Proposal pending client review
                                          </span>
                                        </div>
                                      </div>
                                    )}

                                    {/* Show resolved status if milestone was disputed and is now resolved */}
                                    {(milestone.status === "resolved" || (milestone.status === "disputed" && milestone.resolvedAt)) && (
                                      <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                                        <div className="flex items-center gap-2 mb-2">
                                          <Badge className="bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200">
                                            Dispute Resolved
                                          </Badge>
                                        </div>
                                        {(() => {
                                          // Read freelancer amount: prefer milestone prop, fall back to localStorage
                                          const lsFA = localStorage.getItem(`resolution_fa_${escrow.id}_${index}`);
                                          const freelancerAmt = milestone.resolutionAmount !== undefined
                                            ? Number(milestone.resolutionAmount)
                                            : lsFA !== null ? Number(lsFA) : null;
                                          const milestoneAmt = Number(milestone.amount);

                                          if (freelancerAmt !== null) {
                                            if (freelancerAmt === 0) {
                                              return (
                                                <p className="text-orange-600 dark:text-orange-400 font-medium">
                                                  ❌ Client won — Full refund issued
                                                </p>
                                              );
                                            } else if (freelancerAmt >= milestoneAmt) {
                                              return (
                                                <p className="text-green-600 dark:text-green-400 font-medium">
                                                  ✅ You won! Full payment released
                                                </p>
                                              );
                                            } else {
                                              const percentage = Math.round((freelancerAmt / milestoneAmt) * 100);
                                              return (
                                                <p className="text-blue-600 dark:text-blue-400 font-medium">
                                                  ⚖️ Split decision — You received {percentage}% of milestone amount
                                                </p>
                                              );
                                            }
                                          }
                                          // No amount data available — show neutral message
                                          return (
                                            <p className="text-sm text-blue-700 dark:text-blue-300">
                                              Dispute resolved by admin. Check your earnings balance for payment details.
                                            </p>
                                          );
                                        })()}
                                      </div>
                                    )}

                                    {/* Show disputed status if milestone is disputed AND NOT resolved */}
                                    {milestone.status === "disputed" && !milestone.resolvedAt && (
                                      <div className="mt-3 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg border border-orange-200 dark:border-orange-800">
                                        <div className="flex items-center gap-2 mb-2">
                                          <Badge className="bg-orange-100 dark:bg-orange-800 text-orange-800 dark:text-orange-200">
                                            Disputed - Under Review
                                          </Badge>
                                        </div>
                                        <p className="text-sm text-orange-700 dark:text-orange-300 mb-3">
                                          This milestone is currently under
                                          dispute. The admin will review the
                                          case and make a fair resolution.
                                        </p>
                                        {milestone.disputeReason && (
                                          <div className="mt-2 p-2 bg-orange-100 dark:bg-orange-800/30 rounded border border-orange-200 dark:border-orange-700">
                                            <p className="text-xs font-medium text-orange-800 dark:text-orange-200 mb-1">
                                              Reason for dispute:
                                            </p>
                                            <p className="text-sm text-orange-700 dark:text-orange-300">
                                              {milestone.disputeReason}
                                            </p>
                                          </div>
                                        )}
                                        <div className="flex gap-2 mt-3">
                                          <ViewEvidenceButton
                                            escrowId={escrow.id}
                                            milestoneIndex={index}
                                            clientAddress={escrow.payer}
                                            freelancerAddress={escrow.beneficiary}
                                            variant="outline"
                                            size="sm"
                                            className="flex-1"
                                          />
                                          <EvidenceSubmissionButton
                                            escrowId={escrow.id}
                                            milestoneIndex={index}
                                            onEvidenceSubmitted={() => {
                                              toast({
                                                title: "Evidence submitted",
                                                description: "Your evidence has been recorded",
                                              });
                                            }}
                                            otherPartyAddress={escrow.payer}
                                            projectTitle={escrow.projectTitle}
                                            variant="default"
                                            size="sm"
                                            className="flex-1"
                                          />
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {/* Current Milestone Submission Form */}
                            {(() => {
                              // Find the current milestone that can be submitted
                              // Only allow submission of the next milestone in sequence
                              let currentMilestoneIndex = -1;

                              for (
                                let i = 0;
                                i < escrow.milestones.length;
                                i++
                              ) {
                                const milestone = escrow.milestones[i];
                                const milestoneKey = `${escrow.id}-${i}`;

                                // Check if this milestone is pending and can be submitted
                                if (
                                  milestone.status === "pending" &&
                                  !submittedMilestones.has(milestoneKey) &&
                                  !approvedMilestones.has(milestoneKey)
                                ) {
                                  // For the first milestone, it can always be submitted if pending
                                  if (i === 0) {
                                    currentMilestoneIndex = i;
                                    break;
                                  }

                                  // For subsequent milestones, check if the previous one is approved
                                  const previousMilestone =
                                    escrow.milestones[i - 1];
                                  const previousMilestoneKey = `${escrow.id}-${
                                    i - 1
                                  }`;

                                  // Check if previous milestone is approved
                                  const isPreviousApproved =
                                    previousMilestone &&
                                    (previousMilestone.status === "approved" ||
                                      approvedMilestones.has(
                                        previousMilestoneKey
                                      ));

                                  // Check if there are any submitted milestones before this one that aren't approved
                                  let hasUnapprovedSubmitted = false;
                                  for (let j = 0; j < i; j++) {
                                    const prevMilestone = escrow.milestones[j];
                                    const prevMilestoneKey = `${escrow.id}-${j}`;
                                    const isPrevSubmitted =
                                      prevMilestone.status === "submitted" ||
                                      submittedMilestones.has(prevMilestoneKey);
                                    const isPrevApproved =
                                      prevMilestone.status === "approved" ||
                                      approvedMilestones.has(prevMilestoneKey);

                                    if (isPrevSubmitted && !isPrevApproved) {
                                      hasUnapprovedSubmitted = true;
                                      break;
                                    }
                                  }

                                  // Only allow submission if previous milestone is approved AND no submitted milestones are pending
                                  if (
                                    isPreviousApproved &&
                                    !hasUnapprovedSubmitted
                                  ) {
                                    currentMilestoneIndex = i;
                                    break;
                                  }
                                }
                              }

                              if (currentMilestoneIndex === -1) {
                                return (
                                  <div className="p-4 bg-muted/40 rounded-lg text-center">
                                    <p className="text-muted-foreground">
                                      All milestones completed or in progress
                                    </p>
                                  </div>
                                );
                              }

                              const currentMilestone =
                                escrow.milestones[currentMilestoneIndex];
                              const milestoneKey = `${escrow.id}-${currentMilestoneIndex}`;
                              const isSubmitted =
                                currentMilestone.status === "submitted" ||
                                submittedMilestones.has(milestoneKey);
                              const canSubmit =
                                currentMilestone.status === "pending" &&
                                escrow.status === "active" &&
                                !submittedMilestones.has(milestoneKey) &&
                                !approvedMilestones.has(milestoneKey);

                              // Don't show form if milestone is already submitted
                              if (isSubmitted) {
                                return (
                                  <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <h5 className="font-semibold text-yellow-900 dark:text-yellow-100 mb-1">
                                          Milestone {currentMilestoneIndex + 1}{" "}
                                          Submitted
                                        </h5>
                                        <p className="text-sm text-yellow-700 dark:text-yellow-300">
                                          Awaiting client approval...
                                        </p>
                                      </div>
                                      <div className="flex gap-2">
                                        <Badge className="bg-yellow-100 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-100">
                                          Submitted
                                        </Badge>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => {
                                            setSelectedEscrowId(escrow.id);
                                            setSelectedMilestoneIndex(
                                              currentMilestoneIndex
                                            );
                                            setDisputeReason("");
                                            setShowDisputeDialog(true);
                                          }}
                                        >
                                          Dispute
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                );
                              }

                              return (
                                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                                  <h5 className="font-semibold text-blue-900 dark:text-blue-100 mb-3">
                                    Submit Milestone {currentMilestoneIndex + 1}
                                  </h5>

                                  {/* Client Requirements */}
                                  {currentMilestone.description &&
                                    !currentMilestone.description.includes(
                                      "To be defined"
                                    ) &&
                                    currentMilestone.description !==
                                      `Milestone ${currentMilestoneIndex + 1}` && (
                                      <div className="mb-3 p-3 bg-card rounded border border-border">
                                        <div className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-1">
                                          Client Requirements:
                                        </div>
                                        <div className="text-sm text-blue-700 dark:text-blue-300">
                                          {currentMilestone.description}
                                        </div>
                                      </div>
                                    )}

                                  {/* Show input form only if not submitted */}
                                  {!isSubmitted && (
                                    <div className="space-y-3">
                                      <div>
                                        <label className="block text-sm font-medium text-foreground mb-2">
                                          Your Work Description
                                        </label>
                                        <Textarea
                                          value={
                                            milestoneDescriptions[
                                              milestoneKey
                                            ] || ""
                                          }
                                          onChange={(e) =>
                                            setMilestoneDescriptions(
                                              (prev) => ({
                                                ...prev,
                                                [milestoneKey]: e.target.value,
                                              })
                                            )
                                          }
                                          className="text-sm bg-card border-input text-foreground"
                                          rows={3}
                                          placeholder="Describe what you've completed for this milestone..."
                                        />
                                      </div>

                                      {/* File attachment */}
                                      {isApiConfigured() && (
                                        <div>
                                          <label className="block text-sm font-medium text-foreground mb-1.5">
                                            Attach File{" "}
                                            <span className="font-normal text-muted-foreground">
                                              (optional · PDF, images, docs · max 10 MB)
                                            </span>
                                          </label>
                                          {milestoneAttachments[milestoneKey] ? (
                                            <div className="flex items-center gap-2 p-2 rounded bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 text-sm">
                                              <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                                              <span className="truncate text-green-700 dark:text-green-300">
                                                {milestoneAttachments[milestoneKey]!.filename}
                                              </span>
                                              <button
                                                type="button"
                                                className="ml-auto text-muted-foreground hover:text-destructive text-xs shrink-0"
                                                onClick={() =>
                                                  setMilestoneAttachments(
                                                    (prev) => ({
                                                      ...prev,
                                                      [milestoneKey]: null,
                                                    })
                                                  )
                                                }
                                              >
                                                Remove
                                              </button>
                                            </div>
                                          ) : milestoneFiles[milestoneKey] ? (
                                            <div className="flex items-center gap-2 p-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 text-sm">
                                              <Clock className="h-4 w-4 text-blue-500 shrink-0 animate-pulse" />
                                              <span className="truncate text-blue-700 dark:text-blue-300">
                                                {milestoneFiles[milestoneKey]!.name}
                                              </span>
                                              <button
                                                type="button"
                                                className="ml-auto text-muted-foreground hover:text-destructive text-xs shrink-0"
                                                onClick={() =>
                                                  setMilestoneFiles((prev) => ({
                                                    ...prev,
                                                    [milestoneKey]: null,
                                                  }))
                                                }
                                              >
                                                Remove
                                              </button>
                                            </div>
                                          ) : (
                                            <label className="flex items-center justify-center gap-2 p-2.5 rounded border-2 border-dashed border-input cursor-pointer hover:border-primary/50 transition-colors text-sm text-muted-foreground">
                                              <input
                                                type="file"
                                                className="sr-only"
                                                accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.zip,.doc,.docx"
                                                onChange={(e) => {
                                                  const f =
                                                    e.target.files?.[0];
                                                  if (f)
                                                    setMilestoneFiles(
                                                      (prev) => ({
                                                        ...prev,
                                                        [milestoneKey]: f,
                                                      })
                                                    );
                                                }}
                                              />
                                              <span>
                                                Click to attach a file
                                              </span>
                                            </label>
                                          )}
                                        </div>
                                      )}

                                      <div className="flex gap-2">
                                        {canSubmit && (
                                          <Button
                                            size="sm"
                                            onClick={() =>
                                              submitMilestone(
                                                escrow.id,
                                                currentMilestoneIndex
                                              )
                                            }
                                            disabled={
                                              submittingMilestone ===
                                                milestoneKey ||
                                              milestoneUploading[milestoneKey] ||
                                              !milestoneDescriptions[
                                                milestoneKey
                                              ]?.trim()
                                            }
                                          >
                                            {milestoneUploading[milestoneKey]
                                              ? "Uploading…"
                                              : submittingMilestone ===
                                                milestoneKey
                                              ? "Submitting..."
                                              : "Submit Milestone"}
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Show submitted status if milestone is submitted */}
                                  {isSubmitted && (
                                    <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                                      <div className="flex items-center gap-2 mb-2">
                                        <Badge className="bg-yellow-100 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200">
                                          Submitted - Awaiting Approval
                                        </Badge>
                                      </div>
                                      <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-3">
                                        Your milestone has been submitted and is
                                        waiting for client approval.
                                      </p>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          setSelectedEscrowId(escrow.id);
                                          setSelectedMilestoneIndex(
                                            currentMilestoneIndex
                                          );
                                          setDisputeReason("");
                                          setShowDisputeDialog(true);
                                        }}
                                        className="border-yellow-300 dark:border-yellow-600 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-800"
                                      >
                                        Dispute
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}

                        {/* Overdue dispute banner (freelancer side) */}
                        {(() => {
                          const now = Date.now();
                          const deadlineAt = escrow.deadlineAt ?? 0;
                          const isOverdue = deadlineAt > 0 && now > deadlineAt;
                          const isActive =
                            escrow.status === "active" ||
                            escrow.status === "pending";
                          if (!isOverdue || !isActive) return null;
                          return (
                            <OverdueFreelancerBanner
                              escrowId={escrow.id}
                              onRaiseDispute={raiseOverdueDispute}
                            />
                          );
                        })()}

                        {/* Actions
                            The overdue banner above ends in a full-width
                            Request Arbitration button and this row started
                            immediately under it, so Start Work sat flush
                            against it and the two read as one double-height
                            control rather than two separate decisions.
                            Wraps rather than squeezing on a phone. */}
                        <div className="flex flex-wrap items-center gap-3 mt-5 pt-4 border-t border-border/40">
                          {escrow.status === "pending" && (
                            <Button
                              onClick={() => startWork(escrow.id)}
                              disabled={startingWorkId === escrow.id}
                              className="flex items-center gap-2"
                            >
                              {startingWorkId === escrow.id ? (
                                <>
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                  Starting…
                                </>
                              ) : (
                                <>
                                  <Play className="h-4 w-4" />
                                  Start Work
                                </>
                              )}
                            </Button>
                          )}
                          {/* Their own score, and nothing else's. The client
                              is choosing between people and sees the whole
                              ranking; an applicant needs to know how they did
                              without being shown strangers' rejections. */}
                          <div className="w-full mb-3">
                            <ApplicantScores
                              escrowId={escrow.id}
                              isClient={false}
                              viewer={wallet.address ?? undefined}
                            />
                          </div>

                          {/* Beside Start Work, not instead of it: the two are
                              the same decision seen from either side, and a
                              freelancer who was named on a job they never
                              agreed to needs the second one to exist at all. */}
                          {escrow.status === "pending" && (
                            <DeclineAssignment
                              escrowId={Number(escrow.id)}
                              clientAddress={escrow.payer}
                              jobTitle={escrow.projectTitle}
                              onDone={() => window.dispatchEvent(new CustomEvent("escrowUpdated"))}
                            />
                          )}
                          {escrow.status === "active" && (
                            <Badge className="bg-green-100 dark:bg-green-800 text-green-800 dark:text-green-100">
                              Work Started
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
            </div>
          </div>
        )}

        {/* Chat Dialog — message the client for the selected job */}
        {chatOpenEscrowId && wallet.address && (() => {
          const chatEscrow = escrows.find((e) => e.id === chatOpenEscrowId);
          if (!chatEscrow?.payer) return null;
          return (
            <ChatDialog
              open={!!chatOpenEscrowId}
              onOpenChange={(open) => setChatOpenEscrowId(open ? chatOpenEscrowId : null)}
              myAddress={wallet.address}
              otherAddress={chatEscrow.payer}
            />
          );
        })()}

        {/* Dispute Dialog */}
        {showDisputeDialog && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-lg flex items-center justify-center z-50">
            <Card className="w-full max-w-md mx-4">
              <CardHeader>
                <CardTitle>Open Dispute</CardTitle>
                <CardDescription>
                  Provide a reason for disputing this milestone
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Dispute Reason
                    </label>
                    <textarea
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                      placeholder="Explain why you're disputing this milestone..."
                      className="w-full p-3 border rounded-lg resize-none"
                      rows={4}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        if (
                          selectedEscrowId &&
                          selectedMilestoneIndex !== null
                        ) {
                          openDispute(
                            selectedEscrowId,
                            selectedMilestoneIndex,
                            disputeReason
                          );
                          setShowDisputeDialog(false);
                        }
                      }}
                      disabled={
                        !disputeReason.trim() || submittingMilestone !== null
                      }
                      className="flex-1"
                    >
                      {submittingMilestone ? "Opening..." : "Open Dispute"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setShowDisputeDialog(false)}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Resubmit Dialog */}
        {showResubmitDialog && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-lg flex items-center justify-center z-50">
            <Card className="w-full max-w-md mx-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Resubmit Milestone</CardTitle>
                <CardDescription className="text-sm">
                  Resubmit milestone{" "}
                  {selectedResubmitMilestone !== null
                    ? selectedResubmitMilestone + 1
                    : ""}{" "}
                  for client review. Make sure you've addressed the feedback.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-3">
                  {/* Show rejection reason if available */}
                  {selectedResubmitEscrow &&
                    selectedResubmitMilestone !== null && (
                      <div>
                        <label className="block text-sm font-medium mb-1.5 text-red-600">
                          Rejection Reason
                        </label>
                        <div className="p-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-800 dark:text-red-300">
                          {(() => {
                            const escrow = escrows.find(
                              (e) => e.id === selectedResubmitEscrow
                            );
                            if (
                              escrow &&
                              escrow.milestones &&
                              escrow.milestones[selectedResubmitMilestone]
                            ) {
                              const milestone =
                                escrow.milestones[selectedResubmitMilestone];
                              // The rejection reason should be in the last field of the milestone data
                              return (
                                milestone.rejectionReason ||
                                "No reason provided"
                              );
                            }
                            return "No reason provided";
                          })()}
                        </div>
                      </div>
                    )}

                  <div>
                    <label className="block text-sm font-medium mb-1.5">
                      Update Message
                    </label>
                    <textarea
                      value={resubmitDescription}
                      onChange={(e) => setResubmitDescription(e.target.value)}
                      placeholder="Describe the improvements you've made to address the client's feedback..."
                      className="w-full p-2.5 border rounded-lg resize-none text-sm"
                      rows={3}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      This message will be sent to the client along with your
                      resubmission.
                    </p>
                  </div>

                  {isApiConfigured() && (
                    <div>
                      <label className="block text-sm font-medium mb-1.5">
                        Attachment{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </label>
                      {resubmitFile ? (
                        <div className="flex items-center justify-between gap-2 p-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg text-sm">
                          <span className="truncate text-blue-700 dark:text-blue-300 flex-1">
                            {resubmitFile.name}
                          </span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive px-2"
                            onClick={() => setResubmitFile(null)}
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <label className="flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 border-dashed border-input cursor-pointer hover:border-primary/40 text-sm text-muted-foreground">
                          <input
                            type="file"
                            className="sr-only"
                            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.zip,.doc,.docx"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) setResubmitFile(f);
                            }}
                          />
                          Click to attach a file
                        </label>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Button
                      onClick={() => {
                        if (
                          selectedResubmitEscrow &&
                          selectedResubmitMilestone !== null
                        ) {
                          resubmitMilestone(
                            selectedResubmitEscrow,
                            selectedResubmitMilestone,
                            resubmitDescription
                          );
                        }
                      }}
                      disabled={
                        !resubmitDescription.trim() ||
                        submittingMilestone !== null ||
                        resubmitUploading
                      }
                      className="flex-1"
                    >
                      {resubmitUploading
                        ? "Uploading…"
                        : submittingMilestone
                        ? "Resubmitting..."
                        : "Resubmit Milestone"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowResubmitDialog(false);
                        setResubmitDescription("");
                        setResubmitFile(null);
                        setSelectedResubmitEscrow(null);
                        setSelectedResubmitMilestone(null);
                      }}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
