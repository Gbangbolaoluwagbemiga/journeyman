import { encodeJobId } from "@/lib/id-codec";
import {
  positionFilledMessage,
  unsuccessfulApplicants,
} from "@/lib/atelier/hire-notifications";
import { useState, useEffect } from "react";
import { useWriteContract } from "wagmi";
import { Card } from "@/components/ui/card";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { useJobCreatorStatus } from "@/hooks/use-job-creator-status";
import { usePendingApprovals } from "@/hooks/use-pending-approvals";
import { CONTRACTS } from "@/lib/web3/config";

import {
  useNotifications,
  createApplicationNotification,
} from "@/contexts/notification-context";
import type { Escrow, Application } from "@/lib/web3/types";

/** Pull the [Portfolio/Attachment: name](url) block out of a cover letter. */
function parseCoverLetter(text: string): { body: string; attachment?: { name: string; url: string } } {
  const re = /\[Portfolio\/Attachment:\s*([^\]]+)\]\((https?:\/\/[^)]+)\)/i;
  const match = re.exec(text);
  if (!match) return { body: text };
  return {
    body: text.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim(),
    attachment: { name: match[1].trim(), url: match[2].trim() },
  };
}

import { Briefcase, MessageSquare, Paperclip } from "lucide-react";
import { ApprovalsHeader } from "@/components/approvals/approvals-header";
import { ApprovalsStats } from "@/components/approvals/approvals-stats";
import { JobCard } from "@/components/approvals/job-card";
import { ApprovalsLoading } from "@/components/approvals/approvals-loading";
import { BadgeDisplay, RatingDisplay } from "@/components/rating/badge-display";
import { humanizeError } from "@/lib/atelier/errors";

interface JobWithApplications extends Escrow {
  applications: Application[];
  applicationCount: number;
  projectDescription?: string;
  isOpenJob?: boolean;
}

export default function ApprovalsPage() {
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const { isJobCreator, loading: isJobCreatorLoading } = useJobCreatorStatus();
  const { refreshApprovals } = usePendingApprovals();
  const { addNotification, addCrossWalletNotification } = useNotifications();
  const [jobs, setJobs] = useState<JobWithApplications[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<JobWithApplications | null>(
    null
  );
  const [selectedFreelancer, setSelectedFreelancer] =
    useState<Application | null>(null);
  const [selectedJobForApproval, setSelectedJobForApproval] =
    useState<JobWithApplications | null>(null);

  // Debug selectedFreelancer changes
  useEffect(() => {
    if (selectedFreelancer === null) {
    }
  }, [selectedFreelancer]);
  const [approving, setApproving] = useState(false);
  const [, setIsApproving] = useState(false); // Used in handlers

  const getStatusFromNumber = (
    status: number
  ): Escrow["status"] => {
    switch (status) {
      case 0: return "pending";
      case 1: return "active";
      case 2: return "completed";
      case 3: return "refunded";
      case 4: return "disputed";
      case 5: return "expired";
      case 6: return "cancelled";
      default: return "pending";
    }
  };

  const fetchMyJobs = async () => {
    if (!wallet.isConnected || !isJobCreator) return;

    setLoading(true);
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);

      // Use ContractService instead of contract.call - it reads from blockchain
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      // Get next escrow ID from blockchain (not hardcoded)
      const nextEscrowId = await contractService.getNextEscrowId();

      const myJobs: JobWithApplications[] = [];

      // Check up to 20 escrows (reasonable limit)
      const maxEscrowsToCheck = Math.min(nextEscrowId - 1, 20);
      for (let i = 1; i <= maxEscrowsToCheck; i++) {
        try {
          const escrow = await contractService.getEscrow(i);

          if (!escrow) {
            continue;
          }

          const isMyJob =
            wallet.address &&
            escrow.depositor &&
            escrow.depositor.toLowerCase().trim() ===
              wallet.address.toLowerCase().trim();

          if (isMyJob) {
            const zeroAddress = "0x0000000000000000000000000000000000000000";
            const isOpenJob =
              escrow.isOpenJob ||
              !escrow.beneficiary ||
              escrow.beneficiary === zeroAddress;


            if (isOpenJob) {
              let applicationCount = 0;
              const applications: Application[] = [];

              // Get applications from on-chain transaction data
              try {
                const apps = await contractService.getApplicationDetails(i);
                applicationCount = apps.length;

                for (const app of apps) {
                  // Get reputation data for each freelancer
                  const badge = await contractService.getBadge(app.freelancer);
                  const { averageX100, count } = await contractService.getAverageRating(app.freelancer);
                  
                  applications.push({
                    freelancerAddress: app.freelancer,
                    coverLetter: app.coverLetter || "",
                    proposedTimeline: app.proposedTimeline || 0,
                    appliedAt: Date.now(),
                    status: "pending" as const,
                    badge: badge as "Beginner" | "Intermediate" | "Advanced" | "Expert" | undefined,
                    averageRating: averageX100 / 100,
                    ratingCount: count,
                  });
                }

              } catch (error) {
                console.error('Error fetching applications:', error);
                applicationCount = 0;
              }

              const deadlineSeconds = Number(escrow.deadline ?? 0);
              const remainingSeconds = Math.max(0, deadlineSeconds - nowSeconds);
              const durationInDays = Math.max(1, Math.round(remainingSeconds / 86400));

              const job: JobWithApplications = {
                id: i.toString(),
                payer: escrow.depositor,
                beneficiary: escrow.beneficiary || zeroAddress,
                token: escrow.token || "",
                totalAmount: escrow.totalAmount?.toString() ?? "0",
                releasedAmount: escrow.paidAmount?.toString() ?? "0",
                status: getStatusFromNumber(escrow.status || 0),
                createdAt: Date.now(),
                duration: durationInDays,
                deadlineAt: deadlineSeconds * 1000,
                milestones: [],
                projectTitle: escrow.projectTitle || "",
                projectDescription: escrow.projectDescription || "",
                isOpenJob: true,
                applications,
                applicationCount: Number(applicationCount),
              };

              myJobs.push(job);
            }
          }
        } catch (error) {
          continue;
        }
      }

      setJobs(myJobs);
    } catch (error) {
      toast({
        title: "Failed to load jobs",
        description: "Could not fetch your job postings",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleApproveFreelancer = async () => {

    if (!selectedJobForApproval || !selectedFreelancer || !wallet.isConnected) {
      toast({
        title: "Error",
        description: "Missing required information. Please try again.",
        variant: "destructive",
      });
      return;
    }

    if (!wallet.address) {
      toast({
        title: "Error",
        description: "Wallet address not found. Please reconnect your wallet.",
        variant: "destructive",
      });
      return;
    }

    setApproving(true);

    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      await cs.acceptFreelancer({
        escrow_id: Number(selectedJobForApproval.id),
        freelancer: selectedFreelancer.freelancerAddress,
        depositor: wallet.address,
      }, writeContractAsync);

      toast({
        title: "Freelancer Approved",
        description: "The freelancer has been approved for this job",
      });

      // 1. Notify the APPROVED freelancer using cross-wallet notification
      addCrossWalletNotification(
        {
          type: "application",
          title: "🎉 You've Been Accepted!",
          message: `Congratulations! You've been accepted for "${selectedJobForApproval.projectTitle || `${encodeJobId(selectedJobForApproval.id)}`}". Work is ready to start!`,
          actionUrl: `/freelancer?escrow=${selectedJobForApproval.id}`,
          data: {
            escrowId: selectedJobForApproval.id,
            projectTitle: selectedJobForApproval.projectTitle || `${encodeJobId(selectedJobForApproval.id)}`,
            clientAddress: wallet.address,
            action: "freelancer_accepted",
          },
        },
        undefined, // clientAddress (not needed here)
        selectedFreelancer.freelancerAddress // freelancerAddress
      );

      // Dispatch event for freelancer acceptance notification (real-time)
      window.dispatchEvent(new CustomEvent("freelancerAccepted", {
        detail: {
          escrowId: selectedJobForApproval.id,
          projectTitle: selectedJobForApproval.projectTitle || `${encodeJobId(selectedJobForApproval.id)}`,
          clientAddress: wallet.address,
          freelancerAddress: selectedFreelancer.freelancerAddress,
          jobTitle: selectedJobForApproval.projectTitle || `${encodeJobId(selectedJobForApproval.id)}`,
        }
      }));

      // 2. Notify the CLIENT (confirming their approval action)
      addNotification(
        {
          type: "application",
          title: "Freelancer Approved",
          message: `You approved ${selectedFreelancer.freelancerAddress.slice(0, 6)}...${selectedFreelancer.freelancerAddress.slice(-4)} for "${selectedJobForApproval.projectTitle || `${encodeJobId(selectedJobForApproval.id)}`}"`,
          actionUrl: `/dashboard?job=${selectedJobForApproval.id}`,
          data: {
            jobId: Number(selectedJobForApproval.id),
            freelancerAddress: selectedFreelancer.freelancerAddress,
            action: "client_approved",
          },
        },
        [wallet.address]
      );

      /*
       * 3. Tell everyone who applied and did not get it.
       *
       * Re-read from the chain rather than reusing the list this page loaded.
       * That list was fetched when the page opened and the escrow has been
       * live since — somebody who applied five minutes ago is a person this
       * decision is about, and they were being left out because a render
       * happened before they existed. If the read fails we fall back to what
       * we have, because telling most people is better than telling none.
       */
      const jobTitle =
        selectedJobForApproval.projectTitle || encodeJobId(selectedJobForApproval.id);
      let pool: { freelancerAddress: string }[] = selectedJobForApproval.applications;
      try {
        const fresh = await cs.getApplicationDetails(Number(selectedJobForApproval.id));
        if (fresh.length > 0) pool = fresh.map((a) => ({ freelancerAddress: a.freelancer }));
      } catch {
        /* keep the list we already have */
      }

      const { title, message } = positionFilledMessage(jobTitle);
      for (const address of unsuccessfulApplicants(
        pool,
        selectedFreelancer.freelancerAddress,
        wallet.address,
      )) {
        addCrossWalletNotification(
          {
            type: "application",
            title,
            message,
            /* Where they can see it for themselves, rather than the board they
               just came from. The list is the authoritative answer; this
               message is only the nudge towards it. */
            actionUrl: `/my-jobs?tab=applications`,
            data: {
              jobId: Number(selectedJobForApproval.id),
              freelancerAddress: address,
              action: "position_filled",
              selectedFreelancer: selectedFreelancer.freelancerAddress,
            },
          },
          address
        );
      }

      // Close modals first
      setSelectedJob(null);
      setSelectedFreelancer(null);
      setSelectedJobForApproval(null);

      // Wait a moment for the transaction to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Refresh the jobs list
      await fetchMyJobs();

      // Refresh pending approvals status to update navigation
      await refreshApprovals();

      // Force a re-render by updating a dummy state
      setLoading(true);
      setTimeout(() => setLoading(false), 100);
    } catch (error) {
      const errorMessage =
        humanizeError(error);

      toast({
        title: "Approval Failed",
        description: `There was an error approving the freelancer: ${errorMessage}`,
        variant: "destructive",
      });
    } finally {
      setApproving(false);
    }
  };

  useEffect(() => {
    if (wallet.isConnected && isJobCreator) {
      fetchMyJobs();
    }
  }, [wallet.isConnected, isJobCreator]);

  // Don't redirect - let client see the page even if no approvals yet
  // They might want to see their jobs

  // Show loading while checking job creator status
  if (isJobCreatorLoading) {
    return <ApprovalsLoading isConnected={wallet.isConnected} />;
  }

  if (!wallet.isConnected) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <Briefcase className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-2xl font-bold mb-2">Connect Your Wallet</h2>
          <p className="text-muted-foreground">
            Please connect your wallet to view your job postings and manage
            applications.
          </p>
        </div>
      </div>
    );
  }

  if (!isJobCreator) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <Briefcase className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-2xl font-bold mb-2">
            Job Creator Access Required
          </h2>
          <p className="text-muted-foreground">
            You need to be a job creator to access this page.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <ApprovalsLoading isConnected={wallet.isConnected} />;
  }

  // const totalJobs = jobs.length; // Unused
  // const totalApplications = jobs.reduce(
  //   (sum, job) => sum + job.applicationCount,
  //   0
  // ); // Unused
  // const totalValue = jobs.reduce(
  //   (sum, job) => sum + Number(job.totalAmount) / 1e18,
  //   0
  // ); // Unused

  return (
    <div className="container mx-auto px-4 py-8">
      <ApprovalsHeader />

      {/* Manual Refresh Button */}
      <div className="mb-6 flex justify-end">
        <button
          onClick={async () => {
            setLoading(true);
            await fetchMyJobs();
            setLoading(false);
          }}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          🔄 Refresh Jobs
        </button>
      </div>

      <ApprovalsStats jobs={jobs} />

      {jobs.length === 0 ? (
        <Card className="p-8 text-center">
          <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
          <h3 className="text-lg font-semibold mb-2">No Job Postings</h3>
          <p className="text-muted-foreground">
            You haven't created any job postings yet.
          </p>
        </Card>
      ) : (
        <div className="grid gap-6">
          {jobs.map((job, index) => (
            <JobCard
              key={job.id}
              job={job}
              index={index}
              dialogOpen={selectedJob?.id === job.id}
              selectedJob={selectedJob}
              approving={approving}
              onJobSelect={(job: JobWithApplications) => setSelectedJob(job)}
              onDialogChange={(open: boolean) => {
                if (!open) {
                  setSelectedJob(null);
                  setSelectedFreelancer(null);
                }
              }}
              onApprove={(freelancer: string) => {
                const application = job.applications.find(
                  (app) => app.freelancerAddress === freelancer
                );
                if (application) {
                  setSelectedJobForApproval(job); // Store job data for approval
                  setSelectedJob(null); // Close the first modal
                  setSelectedFreelancer(application);
                  setIsApproving(true);
                } else {
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Application Review Modal */}
      {selectedJob && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedJob(null);
              setSelectedFreelancer(null);
            }
          }}
        >
          <div
            className="bg-background rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">
                  Review Applications - {selectedJob.projectTitle}
                </h3>
                <button
                  onClick={() => {
                    setSelectedJob(null);
                    setSelectedFreelancer(null);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>

              {selectedJob.applications.length === 0 ? (
                <div className="text-center py-8">
                  <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                  <p className="text-muted-foreground">No applications yet</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {selectedJob.applications.map((application, index) => (
                    <Card key={index} className="p-4">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <p className="font-medium">Freelancer Address:</p>
                              <p className="text-sm text-muted-foreground font-mono">
                                {application.freelancerAddress}
                              </p>
                              {application.badge && (
                                <BadgeDisplay badge={application.badge} />
                              )}
                              {(application.averageRating !== undefined ||
                                application.ratingCount !== undefined) && (
                                <RatingDisplay
                                  averageRating={application.averageRating}
                                  ratingCount={application.ratingCount}
                                />
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setSelectedJobForApproval(selectedJob); // Store job data for approval
                                setSelectedJob(null); // Close the Application Review Modal
                                setSelectedFreelancer(application);
                                setIsApproving(true);
                              }}
                              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm hover:bg-green-700 cursor-pointer"
                            >
                              Approve
                            </button>
                          </div>
                        </div>

                        <div>
                          <p className="font-medium">Cover Letter:</p>
                          {(() => {
                            const { body, attachment } = parseCoverLetter(application.coverLetter ?? "");
                            return (
                              <>
                                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{body}</p>
                                {attachment && (
                                  <a
                                    href={attachment.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-2 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                                  >
                                    <Paperclip className="h-3.5 w-3.5 shrink-0" />
                                    {attachment.name}
                                  </a>
                                )}
                              </>
                            );
                          })()}
                        </div>

                        <div>
                          <p className="font-medium">Proposed Timeline:</p>
                          <p className="text-sm text-muted-foreground">
                            {application.proposedTimeline} days
                          </p>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Approval/Rejection Confirmation Modal */}
      {(() => {
        return null;
      })()}
      {selectedFreelancer && (
        <div
          className="fixed inset-0 backdrop-blur-sm flex items-center justify-center p-4 z-[100]"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedFreelancer(null);
            }
          }}
        >
          {(() => {
            return null;
          })()}
          <div
            className="bg-background rounded-lg max-w-lg w-full border shadow-2xl"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-4">Approve Freelancer</h3>

              <div className="space-y-4">
                <div>
                  <p className="font-medium mb-2">Freelancer Address:</p>
                  <p className="text-sm text-muted-foreground font-mono break-all bg-muted/30 p-3 rounded-md">
                    {selectedFreelancer.freelancerAddress}
                  </p>
                </div>

                <div className="flex gap-3 justify-end">
                  <button
                    onClick={() => setSelectedFreelancer(null)}
                    className="px-4 py-2 border rounded-md hover:bg-muted"
                    disabled={approving}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleApproveFreelancer();
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                    }}
                    onMouseUp={(e) => {
                      e.stopPropagation();
                    }}
                    className={`px-4 py-2 rounded-md text-white cursor-pointer bg-green-600 hover:bg-green-700 ${
                      approving ? "opacity-75" : ""
                    }`}
                    disabled={false}
                    style={{
                      pointerEvents: "auto",
                      zIndex: 1000,
                      position: "relative",
                    }}
                  >
                    Confirm Approval
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
