import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useWriteContract } from "wagmi";
import { Card } from "@/components/ui/card";
import { useWeb3 } from "@/contexts/web3-context";
import { encodeJobId } from "@/lib/id-codec";
import { useToast } from "@/hooks/use-toast";
import { CONTRACTS } from "@/lib/web3/config";
import { contractService } from "@/lib/web3/contract-service";
import { isGraphConfigured, graphQuery } from "@/lib/graph/client";
import { GET_OPEN_JOBS, type OpenJobsResponse } from "@/lib/graph/queries";
import { normalizeEscrow } from "@/lib/graph/normalize";

import {
  useNotifications,
  createApplicationNotification,
} from "@/contexts/notification-context";
import type { Escrow } from "@/lib/web3/types";
import { Briefcase } from "lucide-react";
import { CATEGORIES, categoryOf } from "@/lib/atelier/categories";
import { JobsHeader } from "@/components/jobs/jobs-header";
import { JobsStats } from "@/components/jobs/jobs-stats";
import { JobCard } from "@/components/jobs/job-card";
import { ApplicationDialog } from "@/components/jobs/application-dialog";
import { JobsLoading } from "@/components/jobs/jobs-loading";
import { currentWorkerId, apply as workerApply } from "@/lib/atelier/worker";
import { useManagedEscrows } from "@/hooks/use-managed-escrows";
import { toastError } from "@/lib/atelier/errors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

export default function JobsPage() {
  const { wallet } = useWeb3();
  /* Which jobs the agent is running, for the Autopilot badge on each card. */
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const { addNotification } = useNotifications();
  const [jobs, setJobs] = useState<Escrow[]>([]);

  /* The jobs on screen, so the badge can be read from the chain in one
     multicall rather than waiting on the agent's housekeeping sweep. */
  const visibleEscrowIds = useMemo(
    () => jobs.map((j) => Number(j.id)).filter((n) => Number.isFinite(n)),
    [jobs],
  );
  const { managed: managedEscrows, refresh: refreshManaged } =
    useManagedEscrows(visibleEscrowIds);

  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  /* Browsing by kind of work. "all" includes jobs posted before categories
     existed, which carry no marker — filtering those out would silently hide
     most of the board. */
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "active" | "completed" | "disputed"
  >("all");
  const [selectedJob, setSelectedJob] = useState<Escrow | null>(null);
  /* /jobs/:jobId opens that job's dialog directly. The agent notifies people
     off-site (Telegram today), and a link that lands them on an unfiltered
     board makes them hunt for the job they were just told about. */
  const { jobId: deepLinkedJobId } = useParams<{ jobId: string }>();
  const [deepLinkConsumed, setDeepLinkConsumed] = useState(false);
  // const [coverLetter, setCoverLetter] = useState(""); // Unused - handled in dialog
  // const [proposedTimeline, setProposedTimeline] = useState(""); // Unused - handled in dialog
  const [applying, setApplying] = useState(false);
  const [hasApplied, setHasApplied] = useState<Record<string, boolean>>({});
  const [isContractPaused, setIsContractPaused] = useState(false);
  const [contractConfigError, setContractConfigError] = useState<string | null>(
    null
  );
  const [ongoingProjectsCount, setOngoingProjectsCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [totalEscrowsCount, setTotalEscrowsCount] = useState(0); // Actual count from blockchain

  const getStatusFromNumber = (
    status: number
  ): "pending" | "disputed" | "active" | "completed" | "cancelled" => {
    switch (status) {
      case 0:
        return "pending";
      case 1:
        return "active";
      case 2:
        return "completed";
      case 3:
        return "disputed";
      case 4:
        return "pending"; // Refunded - map to pending
      case 5:
        return "pending"; // Expired - map to pending
      case 6:
        return "cancelled";
      default:
        return "pending";
    }
  };

  const normalizeJobStatus = (
    raw: unknown
  ): "pending" | "active" | "completed" | "disputed" | "cancelled" => {
    if (typeof raw === "string") {
      const s = raw.toLowerCase().trim();
      if (s === "pending" || s === "active" || s === "completed" || s === "disputed" || s === "cancelled") {
        return s;
      }
      if (s === "cancelled" || s === "canceled") return "cancelled";
      return "pending";
    }

    if (typeof raw === "number") {
      return getStatusFromNumber(raw);
    }

    if (typeof raw === "bigint") {
      return getStatusFromNumber(Number(raw));
    }

    return "pending";
  };

  /*
   * The board loads for everyone, wallet or not.
   *
   * It used to load only when a wallet was connected, which made the public
   * marketplace invisible to the exact people the managed-worker door was built
   * for: someone who signed up with a name and has no wallet at all saw
   * "Wallet Not Connected" on the one page they needed. Reading open jobs
   * requires no signature and no address — only applying does.
   */
  useEffect(() => {
    fetchOpenJobs();
    if (wallet.address) countOngoingProjects();
    checkContractPauseStatus();
  }, [wallet.address]);

  // Removed automatic refresh to prevent constant reloading

  // Check application status when jobs are loaded
  // Don't auto-check application status - fetchOpenJobs already does this
  // This useEffect was causing state to be reset to false
  // useEffect(() => {
  //   if (wallet.address && jobs.length > 0) {
  //     checkApplicationStatus();
  //   }
  // }, [wallet.address, jobs]);

  // Removed duplicate project count refresh

  const checkContractPauseStatus = async () => {
    try {
      const health = await contractService.probeEscrowContractHealth();
      if (!health.ok) {
        setContractConfigError(health.userMessage);
        setIsContractPaused(true);
        return;
      }
      setContractConfigError(null);
      setIsContractPaused(health.jobCreationPaused);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Contract check failed.";
      setContractConfigError(msg);
      setIsContractPaused(true);
    }
  };

  const countOngoingProjects = async () => {
    try {
      if (!wallet.address) {
        setOngoingProjectsCount(0);
        return;
      }

      // Use the contract's user->escrows index instead of relying on the legacy wrapper shape.
      const escrowIds = await contractService.getUserEscrows(wallet.address);

      let ongoingCount = 0;
      for (const id of escrowIds) {
        const escrow = await contractService.getEscrow(id);
        if (!escrow) continue;
        if (escrow.status === 0 || escrow.status === 1) ongoingCount++;
      }

      setOngoingProjectsCount(ongoingCount);
    } catch (error) {
      setOngoingProjectsCount(0);
    }
  };

  const checkApplicationStatus = async () => {
    try {
      // Check blockchain for application status for each job
      if (!wallet.address || jobs.length === 0) return;

      const applicationStatus: Record<string, boolean> = {};

      for (const job of jobs) {
        try {
          const hasAppliedResult = await contractService.hasUserApplied(
            Number.parseInt(job.id, 10),
            wallet.address
          );
          applicationStatus[job.id] = hasAppliedResult;
        } catch (error) {
          // Preserve existing state if check fails
          applicationStatus[job.id] = hasApplied[job.id] || false;
        }
      }

      setHasApplied((prev) => ({
        ...prev,
        ...applicationStatus, // Merge with existing state instead of replacing
      }));
    } catch (error) {
      // Don't reset state on error
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      /* Including the Autopilot badges, which this button used to leave
         untouched — so pressing it after handing a job over spun and changed
         nothing. */
      refreshManaged();
      await Promise.all([fetchOpenJobs(), countOngoingProjects()]);
      // Check application status after refreshing jobs
      if (wallet.address && jobs.length > 0) {
        await checkApplicationStatus();
      }
    } finally {
      setRefreshing(false);
    }
  };

  // Clear application status cache when wallet changes
  useEffect(() => {
    setHasApplied({});
  }, [wallet.address]);

  const fetchOpenJobs = async () => {
    setLoading(true);
    try {
      // ── Try subgraph first ──────────────────────────────────────────────
      if (isGraphConfigured()) {
        try {
          const data = await graphQuery<OpenJobsResponse>(GET_OPEN_JOBS);
          let normalized = (data.escrows ?? []).map((g) =>
            normalizeEscrow(g, wallet.address ?? ""),
          );

          // Enrich all escrows via RPC: subgraph may have stale totalAmount and
          // doesn't index projectTitle/projectDescription from the event.
          const allIds = normalized
            .map((e) => parseInt(e.id, 10))
            .filter((id) => Number.isFinite(id));

          if (allIds.length > 0) {
            try {
              const zeroAddr = "0x0000000000000000000000000000000000000000";
              const rpcBatch = await contractService.getEscrowsBatch(allIds);
              const nowSec = Math.floor(Date.now() / 1000);
              normalized = normalized
                .map((e) => {
                  const rpc = rpcBatch[parseInt(e.id, 10)];
                  if (!rpc) return e;
                  // RPC is authoritative for isOpenJob — subgraph may index it wrong
                  const rpcIsOpen = rpc.isOpenJob || !rpc.beneficiary || rpc.beneficiary === zeroAddr;
                  // RPC deadline is authoritative — catches extendDeadline txns the subgraph hasn't indexed
                  const rpcDeadlineSec = rpc.deadline != null ? Number(rpc.deadline) : null;
                  return {
                    ...e,
                    projectTitle: rpc.projectTitle || e.projectTitle || "",
                    projectDescription: rpc.projectDescription || e.projectDescription || "",
                    totalAmount: rpc.totalAmount != null ? rpc.totalAmount.toString() : e.totalAmount,
                    releasedAmount: rpc.paidAmount != null ? rpc.paidAmount.toString() : e.releasedAmount,
                    isOpenJob: rpcIsOpen,
                    beneficiary: rpc.beneficiary || e.beneficiary,
                    ...(rpcDeadlineSec != null && {
                      duration: Math.max(0, rpcDeadlineSec - nowSec),
                      deadlineAt: rpcDeadlineSec * 1000,
                    }),
                  };
                })
                // Keep only actual open jobs (discard private escrows returned by the broader query)
                .filter((e) => e.isOpenJob);
            } catch {
              // Enrichment failed — fall through, subgraph values kept as-is
            }
          }

          // If subgraph returned jobs, use them; otherwise fall through to RPC
          // (subgraph may be indexing the old contract and return empty for new deployments)
          if (normalized.length > 0) {
            setTotalEscrowsCount(normalized.length);
            setJobs(normalized);

            // Check application status for each job
            if (wallet.address && allIds.length > 0) {
              try {
                const statuses = await Promise.all(
                  allIds.map((id) =>
                    contractService.hasUserApplied(id, wallet.address!).then(
                      (applied) => [id.toString(), applied] as [string, boolean]
                    ).catch(() => [id.toString(), false] as [string, boolean])
                  )
                );
                setHasApplied((prev) => ({
                  ...prev,
                  ...Object.fromEntries(statuses),
                }));
              } catch {
                // Non-critical — button state falls back to "Apply Now"
              }
            }

            // Subgraph lags 10-30 s behind the chain — catch any jobs created
            // after the subgraph's latest indexed block by scanning the delta via RPC.
            try {
              const latestId = await contractService.getNextEscrowId();
              const maxIndexedId = allIds.length > 0 ? Math.max(...allIds) : 0;
              if (latestId - 1 > maxIndexedId) {
                const nowSec = Math.floor(Date.now() / 1000);
                const zeroAddress = "0x0000000000000000000000000000000000000000";
                const newIds = Array.from(
                  { length: Math.min(latestId - 1 - maxIndexedId, 20) },
                  (_, k) => maxIndexedId + k + 1,
                );
                const newBatch = await contractService.getEscrowsBatch(newIds);
                const extra: Escrow[] = [];
                for (const id of newIds) {
                  const d = newBatch[id];
                  if (!d) continue;
                  if (d.isOpenJob || !d.beneficiary || d.beneficiary === zeroAddress) {
                    const deadlineSec = Number(d.deadline ?? 0);
                    extra.push({
                      id: id.toString(),
                      payer: d.depositor,
                      beneficiary: d.beneficiary || zeroAddress,
                      token: d.token || "",
                      totalAmount: d.totalAmount?.toString() ?? "0",
                      releasedAmount: d.paidAmount?.toString() ?? "0",
                      status: getStatusFromNumber(d.status),
                      createdAt: 0,
                      duration: Math.max(0, deadlineSec - nowSec),
                      deadlineAt: deadlineSec * 1000,
                      milestones: [],
                      projectTitle: d.projectTitle || "",
                      projectDescription: d.projectDescription || "",
                      isOpenJob: true,
                      applications: [],
                      applicationCount: 0,
                      isJobCreator: !!(wallet.address && d.depositor && d.depositor.toLowerCase() === wallet.address.toLowerCase()),
                    });
                  }
                }
                if (extra.length > 0) {
                  setJobs((prev) => [...extra, ...prev]);
                  setTotalEscrowsCount((prev) => prev + extra.length);
                }
              }
            } catch {
              // Non-critical — subgraph results already displayed above
            }

            return;
          }
          // Subgraph returned 0 jobs — fall through to RPC scan
        } catch (graphErr) {
          console.warn("[jobs] subgraph query failed, falling back to RPC:", graphErr);
        }
      }

      // ── RPC fallback (multicall) ────────────────────────────────────────
      const nowSeconds = Math.floor(Date.now() / 1000);
      const escrowCount = await contractService.getNextEscrowId();
      const actualCount = Math.max(0, escrowCount - 1);
      setTotalEscrowsCount(actualCount);

      const openJobs: Escrow[] = [];
      const maxEscrowsToFetch = 100;
      const escrowsToCheck = Math.min(Math.max(escrowCount - 1, 0), maxEscrowsToFetch);
      const allIds = Array.from({ length: escrowsToCheck }, (_, k) => k + 1);

      const escrowBatch = escrowsToCheck > 0
        ? await contractService.getEscrowsBatch(allIds)
        : {};

      if (escrowsToCheck > 0) {
        for (const i of allIds) {
          try {
            const escrowData = escrowBatch[i];
            if (!escrowData) {
              continue;
            }

            // Check if this is an open job
            const zeroAddress = "0x0000000000000000000000000000000000000000";
            const isOpenJob =
              escrowData.isOpenJob ||
              !escrowData.beneficiary ||
              escrowData.beneficiary === zeroAddress;

            if (isOpenJob) {
              const isJobCreator =
                wallet.address &&
                escrowData.depositor &&
                escrowData.depositor.toLowerCase().trim() ===
                  wallet.address.toLowerCase().trim();

              // Check if current user has already applied to this job
              // First check local state (preserves state after applying)
              let userHasApplied = hasApplied[i] || false;
              let applicationCount = 0;

              // Only check blockchain if not already in local state
              if (!userHasApplied && wallet.address) {
                try {
                  userHasApplied = await contractService.hasUserApplied(
                    i,
                    wallet.address
                  );
                } catch (error) {
                  userHasApplied = false;
                }
              }

              // deadline is a Unix timestamp (seconds) — directly from block.timestamp
              const deadlineSeconds = Number(escrowData.deadline ?? 0);
              const remainingSeconds = Math.max(0, deadlineSeconds - nowSeconds);

              const job: Escrow = {
                id: i.toString(),
                payer: escrowData.depositor,
                beneficiary: escrowData.beneficiary || zeroAddress,
                token: escrowData.token || "",
                totalAmount: escrowData.totalAmount?.toString() ?? "0",
                releasedAmount: escrowData.paidAmount?.toString() ?? "0",
                status: getStatusFromNumber(escrowData.status),
                createdAt: 0,
                duration: remainingSeconds,
                deadlineAt: deadlineSeconds * 1000,
                milestones: [],
                projectTitle: escrowData.projectTitle || "",
                projectDescription: escrowData.projectDescription || "",
                isOpenJob: true,
                applications: [],
                applicationCount,
                isJobCreator: !!isJobCreator,
              };

              // Log blockchain data for debugging

              openJobs.push(job);

              // Store application status from blockchain check
              setHasApplied((prev) => {
                const newState = {
                  ...prev,
                  [job.id]: userHasApplied, // Always use blockchain result
                };
                return newState;
              });
            }
          } catch (error) {
            // Skip escrows that don't exist or user doesn't have access to
            continue;
          }
        }
      }

      // Fetch accurate createdAt timestamps from subgraph for RPC-discovered jobs
      if (isGraphConfigured() && openJobs.length > 0) {
        try {
          const idsStr = openJobs.map(j => `"${j.id}"`).join(",");
          const result = await graphQuery<{ escrows: { escrowId: string; createdAt: string }[] }>(
            `query { escrows(where: { escrowId_in: [${idsStr}] }) { escrowId createdAt } }`
          );
          const createdAtMap: Record<string, number> = Object.fromEntries(
            (result.escrows ?? []).map(e => [e.escrowId, Number(e.createdAt) * 1000])
          );
          for (const job of openJobs) {
            if (createdAtMap[job.id]) job.createdAt = createdAtMap[job.id];
          }
        } catch {
          // Non-critical — jobs still show, date just won't be accurate
        }
      }

      setJobs(openJobs);
    } catch (error) {
      toast({
        title: "Failed to load jobs",
        description: "Could not fetch available jobs from the blockchain",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async (
    job: Escrow,
    coverLetter: string,
    proposedTimeline: string
  ) => {
    if (!job) return;

    /*
     * Two kinds of freelancer reach this button.
     *
     * Someone with a wallet signs applyToJob themselves, below. Someone who
     * joined through /get-hired has no wallet and no gas — the daemon signs for
     * them with the Circle MPC wallet it provisioned. Routing both through the
     * same handler is what stops the marketplace splitting into two, which is
     * the whole point of one job list.
     */
    if (!wallet.isConnected) {
      const workerId = currentWorkerId();
      if (!workerId) {
        toast({
          title: "Sign in first",
          description:
            "Connect a wallet, or get an account in one step from Get Hired.",
          variant: "destructive",
        });
        return;
      }
      try {
        await workerApply({
          workerId,
          escrowId: String(job.id),
          coverLetter,
          proposedTimelineDays: Number(proposedTimeline) || undefined,
        });
        toast({
          title: "Application sent",
          description: "No gas, no signature — we signed it for you.",
        });
        setHasApplied((prev: Record<string, boolean>) => ({ ...prev, [job.id]: true }));

        /*
         * Close it, and tell the client — both of which the wallet path below
         * already did and this one did not.
         *
         * Leaving the dialog open after a successful send reads as a failure:
         * somebody applied, saw the form still sitting there, submitted again,
         * and was told they had already applied — by which point the only
         * evidence it had worked was a toast that had already gone.
         */
        setSelectedJob(null);
        if (job.payer) {
          addNotification(
            createApplicationNotification("submitted", Number(job.id), workerId, {
              jobTitle: job.projectTitle || encodeJobId(job.id),
              freelancerName: "a managed worker",
            }),
            [job.payer],
          );
        }
      } catch (e) {
        toast(toastError("Could not send that application", e));
      }
      return;
    }

    // Check if user is the job creator (should not be able to apply to own job)
    if (
      job.isJobCreator ||
      job.payer?.toLowerCase() === wallet.address?.toLowerCase()
    ) {
      toast({
        title: "Cannot Apply",
        description: "You cannot apply to a job you created.",
        variant: "destructive",
      });
      return;
    }

    // Block applications to jobs whose deadline has passed
    if (job.duration === 0 && (job.deadlineAt ?? 0) > 0) {
      toast({
        title: "Job Expired",
        description: "The deadline for this job has passed.",
        variant: "destructive",
      });
      return;
    }

    // Check if freelancer has reached the maximum number of ongoing projects (3)
    if (ongoingProjectsCount >= 3) {
      toast({
        title: "Project Limit Reached",
        description:
          "You can only have a maximum of 3 ongoing projects at a time. Please complete or cancel some projects before applying to new ones.",
        variant: "destructive",
      });
      return;
    }

    // Check if user has already applied to this job (local state)
    if (hasApplied[job.id]) {
      toast({
        title: "Already Applied",
        description: "You have already applied to this job.",
        variant: "destructive",
      });
      return;
    }

    setApplying(true);
    try {
      // Check if user has already applied to this job using contractService
      // Always check blockchain to prevent double applications
      let userHasApplied = false;
      if (wallet.address) {
        try {
          const hasAppliedResult = await contractService.hasUserApplied(
            Number.parseInt(job.id, 10),
            wallet.address
          );
          userHasApplied = hasAppliedResult;
        } catch (error) {
          // If check fails, use local state as fallback
          userHasApplied = hasApplied[job.id] || false;
        }
      }

      if (userHasApplied) {
        toast({
          title: "Already Applied",
          description: "You have already applied to this job.",
          variant: "destructive",
        });
        setApplying(false);
        return;
      } else {
      }

      // Apply to the job via the gasless path — admin wallet pays the fee,
      // Gasless: relayer pays gas via EIP-2771 forwarder.
      const { ContractService: GaslessCS } = await import(
        "@/lib/web3/contract-service"
      );
      const gaslessService = new GaslessCS(CONTRACTS.ATELIER_ESCROW);
      await gaslessService.applyToJob({
        escrow_id: Number.parseInt(job.id, 10),
        cover_letter: coverLetter,
        proposed_timeline: Number.parseInt(proposedTimeline, 10),
        freelancer: wallet.address || "",
      }, writeContractAsync);

      // Update hasApplied state to prevent double application
      setHasApplied((prev) => ({
        ...prev,
        [job.id]: true,
      }));

      toast({
        title: "Application Submitted!",
        description:
          "The client will review your application and get back to you.",
      });

      // Add notification for job application submission - notify the CLIENT (job creator)
      addNotification(
        createApplicationNotification(
          "submitted",
          Number(job.id),
          wallet.address!,
          {
            jobTitle: job.projectTitle || encodeJobId(job.id),
            freelancerName:
              wallet.address!.slice(0, 6) + "..." + wallet.address!.slice(-4),
          }
        ),
        [job.payer] // Notify the client (job creator)
      );

      // coverLetter and proposedTimeline are handled in the dialog component
      setSelectedJob(null);

      // DON'T refresh jobs list immediately - it will reset hasApplied state
      // The application is already recorded on blockchain, just update local state
      // Only refresh if needed for other reasons

      // Refresh the ongoing projects count
      await countOngoingProjects();
    } catch (error: any) {
      const msg =
        error?.message || "Could not submit your application. Please try again.";
      toast({
        title: "Application Failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setApplying(false);
    }
  };

  const filteredJobs = jobs.filter((job) => {
    // Search filter - check both title and description
    const matchesSearch =
      !searchQuery ||
      job.projectTitle?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.projectDescription?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.milestones.some((m) =>
        m.description.toLowerCase().includes(searchQuery.toLowerCase())
      );

    // Status filter - normalize both sides for comparison
    const jobStatus = normalizeJobStatus(job.status);
    const matchesStatus = statusFilter === "all" || jobStatus === statusFilter;
    const matchesCategory =
      categoryFilter === "all" || categoryOf(job.projectDescription) === categoryFilter;

    // Don't show cancelled jobs
    const isNotCancelled = jobStatus !== "cancelled";

    // Don't show expired pending jobs — deadline has passed, contract will reject applications
    const isNotExpired = !(jobStatus === "pending" && job.duration === 0 && (job.deadlineAt ?? 0) > 0);

    // Show all jobs including user's own jobs (apply button will be disabled for own jobs)
    return matchesSearch && matchesStatus && matchesCategory && isNotCancelled && isNotExpired;
  });

  /* Only a genuine load blocks the page now. A missing wallet does not — see
     the fetch effect above. */
  /*
   * /jobs/:jobId opens that job's dialog directly, for links the agent sends
   * off-site. Fires once, after the board loads, so closing the dialog sticks.
   *
   * Must sit here, with the other hooks and above the `loading` return. It was
   * originally placed inside the job map, which called a hook per row and only
   * on the renders that got that far — React refuses to render at all in that
   * situation, so Browse Jobs went blank rather than merely misbehaving.
   */
  useEffect(() => {
    if (deepLinkConsumed || !deepLinkedJobId || jobs.length === 0) return;
    const match = jobs.find((j) => j.id === deepLinkedJobId);
    setDeepLinkConsumed(true);
    if (match) setSelectedJob(match);
  }, [deepLinkedJobId, jobs, deepLinkConsumed]);

  if (loading) {
    return <JobsLoading isConnected />;
  }

  return (
    <div className="min-h-screen py-12">
      <div className="container mx-auto px-4">
        <JobsHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
        {contractConfigError && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Escrow contract unavailable</AlertTitle>
            <AlertDescription>{contractConfigError}</AlertDescription>
          </Alert>
        )}
        <JobsStats
          jobs={filteredJobs}
          openJobsCount={filteredJobs.length}
          ongoingProjectsCount={ongoingProjectsCount}
        />

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="flex-1">
            <Label htmlFor="status-filter" className="mb-2 block">
              Filter by Status
            </Label>
            <Select
              value={statusFilter}
              onValueChange={(value: any) => setStatusFilter(value)}
            >
              <SelectTrigger id="status-filter" className="w-full">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="active">Active</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1">
            <Label htmlFor="category-filter" className="mb-2 block">
              Filter by Kind of Work
            </Label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger id="category-filter" className="w-full">
                <SelectValue placeholder="All Kinds" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Kinds</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Jobs List */}
        <div className="space-y-6">
          {filteredJobs.length === 0 ? (
            <Card className="glass border-muted p-12 text-center">
              <Briefcase className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-50" />
              {jobs.length === 0 ? (
                <>
                  <h3 className="text-xl font-semibold mb-2">No Open Jobs Available</h3>
                  <p className="text-muted-foreground">
                    There are currently no open jobs on the platform. Check back later for new opportunities!
                  </p>
                </>
              ) : (
                <>
                  <h3 className="text-xl font-semibold mb-2">No Jobs Match Your Filters</h3>
                  <p className="text-muted-foreground">
                    Try adjusting your search or filter criteria to find more jobs.
                  </p>
                </>
              )}
            </Card>
          ) : (
            <>
              <div className="text-sm text-muted-foreground">
                Showing {filteredJobs.length} {filteredJobs.length === 1 ? 'job' : 'jobs'}
              </div>
              {filteredJobs.map((job, index) => {
                const jobHasApplied = hasApplied[job.id] || false;
                return (
                  <JobCard
                    key={job.id}
                    job={job}
                    index={index}
                    isAutopilot={managedEscrows.has(String(job.id))}
                    hasApplied={jobHasApplied}
                    isContractPaused={isContractPaused}
                    ongoingProjectsCount={ongoingProjectsCount}
                    onApply={setSelectedJob}
                  />
                );
              })}
            </>
          )}
        </div>

        <ApplicationDialog
          job={selectedJob}
          open={!!selectedJob}
          onOpenChange={(open) => !open && setSelectedJob(null)}
          onApply={handleApply}
          applying={applying}
        />
      </div>
    </div>
  );
}
