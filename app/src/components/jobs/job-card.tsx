import { useState, useEffect } from "react";
import { encodeJobId } from "@/lib/id-codec";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AutopilotBadge } from "@/components/atelier/autopilot-badge";
import { motion } from "framer-motion";
import { Clock, AlertCircle, History, Sprout, Star, Tag } from "lucide-react";
import { categoryLabel, categoryOf, withoutMarker } from "@/lib/atelier/categories";
import type { Escrow } from "@/lib/web3/types";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";
import { formatEth, formatTokenAmount } from "@/lib/utils";

interface JobCardProps {
  job: Escrow;
  index: number;
  /** True when the agent is running this job end to end. */
  isAutopilot?: boolean;
  hasApplied: boolean;
  isContractPaused: boolean;
  ongoingProjectsCount: number;
  onApply: (job: Escrow) => void;
}

export function JobCard({
  job,
  index,
  isAutopilot = false,
  hasApplied,
  isContractPaused,
  ongoingProjectsCount,
  onApply,
}: JobCardProps) {
  /*
   * Has this job already been through an arbiter and been put back?
   *
   * Read off the milestones rather than passed in, because it is a property of
   * the escrow and the card already has them. A milestone carrying a resolution
   * on a job that is open again can only mean it was reopened after a dispute.
   */
  const hasHistory = (job.milestones ?? []).some(
    (m) => (m.resolvedAt ?? 0) > 0 || m.status === "resolved",
  );

  const category = categoryLabel(categoryOf(job.projectDescription));

  const [clientRating, setClientRating] = useState<{ average: number; count: number } | null>(null);
  const [earning, setEarning] = useState(false);

  useEffect(() => {
    if (!job.payer) return;
    const svc = new ContractService(CONTRACTS.ATELIER_ESCROW);
    svc.getAverageClientRating(job.payer)
      .then((r: any) => { if (r.count > 0) setClientRating({ average: r.averageX100 / 100, count: r.count }); })
      .catch(() => {});
  }, [job.payer]);

  /* Whether this escrow is actually out earning. Read per card, like the rating
     above, and failing to false: a badge promising a bonus that never arrives
     is worse than no badge. */
  useEffect(() => {
    let live = true;
    new ContractService(CONTRACTS.ATELIER_ESCROW)
      .isEarningYield(Number(job.id))
      .then((yes) => { if (live) setEarning(yes); })
      .catch(() => {});
    return () => { live = false; };
  }, [job.id]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "active":
        return "bg-blue-100 text-blue-800";
      case "completed":
        return "bg-green-100 text-green-800";
      case "disputed":
        return "bg-red-100 text-red-800";
      case "resolved":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
    >
      <Card className="glass border-primary/20 p-4 md:p-6 hover:border-primary/40 transition-colors">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <h3 className="text-xl font-bold">
                {job.projectTitle || job.projectDescription || encodeJobId(job.id)}
              </h3>
              <Badge variant="secondary" className="gap-1">
                <Clock className="h-3 w-3" />
                {job.duration > 0 ? Math.max(1, Math.round(job.duration / 86400)) : 0} days
              </Badge>
              <Badge className={getStatusColor(job.status)}>{job.status}</Badge>
              {/* Says what changes for the freelancer — criteria-based review
                  inside a known window — rather than labelling the client a
                  machine. See autopilot-badge.tsx. */}
              {category && (
                <Badge variant="outline" className="gap-1.5" data-testid="category-badge">
                  <Tag className="h-3 w-3" aria-hidden="true" />
                  {category}
                </Badge>
              )}
              {/*
                This job's escrow is deployed and earning, and the freelancer
                takes the larger share of what it earns. Worth a badge because
                it is a reason to pick this job over an identical one — but a
                small one, since it is a bonus on top of the fee, not the fee.
              */}
              {earning && (
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-500 text-[11px] px-2 py-0"
                  title="This job's escrow is invested while you work. You get the larger share of what it earns, on top of the budget."
                  data-testid="earning-badge"
                >
                  <Sprout className="h-3 w-3 yield-live" aria-hidden="true" />
                  Earning
                </Badge>
              )}
              {isAutopilot && <AutopilotBadge />}
              {/*
                A job that has been through arbitration and put back on the
                board. Worth saying out loud: someone applying deserves to know
                there is history here before they commit, and the whole reason
                reopening is fair is that the record survived. Silence would
                make this look like any other fresh posting.
              */}
              {hasHistory && (
                <Badge
                  variant="outline"
                  className="gap-1.5 border-[var(--actor-border)]"
                  data-testid="reopened-badge"
                >
                  <History className="h-3 w-3" aria-hidden="true" />
                  Reopened — previous work visible
                </Badge>
              )}
            </div>

            <p className="text-muted-foreground mb-4 break-words overflow-hidden">
              {withoutMarker(job.projectDescription) || "No description available"}
            </p>

            <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
              <span>Posted {job.createdAt ? new Date(job.createdAt).toLocaleDateString() : "Recently"}</span>
              <span>•</span>
              <span>
                Budget: {formatTokenAmount(job.totalAmount, job.token)}
              </span>
              {clientRating && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1" title={`Client rated ${clientRating.average}/5 by ${clientRating.count} freelancer(s)`}>
                    <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                    <span className="font-medium text-foreground">{clientRating.average.toFixed(1)}</span>
                    <span className="text-xs">({clientRating.count})</span>
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-4 w-full lg:w-auto">
            <div className="text-right w-full lg:w-auto">
              <p className="text-sm text-muted-foreground mb-1">Total Budget</p>
              <p className="text-2xl md:text-3xl font-bold text-primary break-all">
                {formatTokenAmount(job.totalAmount, job.token)}
              </p>
            </div>

            <Button
              onClick={() => onApply(job)}
              disabled={
                hasApplied ||
                isContractPaused ||
                job.isJobCreator ||
                ongoingProjectsCount >= 3
              }
              className="w-full lg:w-auto min-w-[140px]"
            >
              {(() => {
                const buttonText = isContractPaused ? (
                  <>
                    <AlertCircle className="h-4 w-4 mr-2" />
                    Contract Paused
                  </>
                ) : job.isJobCreator ? (
                  "Your Job"
                ) : hasApplied ? (
                  "Applied"
                ) : ongoingProjectsCount >= 3 ? (
                  <>
                    <AlertCircle className="h-4 w-4 mr-2" />
                    Project Limit (3/3)
                  </>
                ) : (
                  "Apply Now"
                );
                return buttonText;
              })()}
            </Button>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
