import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, FileText, CheckCircle2, AlertCircle } from "lucide-react";

interface DashboardStatsProps {
  escrows: Array<{
    totalAmount: string;
    releasedAmount: string;
    status: string;
    milestones: Array<{
      status: string;
    }>;
  }>;
}

/**
 * Statuses where the contract is no longer holding anything for this job.
 *
 * Completed paid it out, cancelled and refunded sent it back, expired was
 * reclaimed. Money in any of these has already gone somewhere.
 */
const SETTLED = new Set(["completed", "cancelled", "refunded", "expired"]);

export function DashboardStats({ escrows }: DashboardStatsProps) {
  /*
   * What the escrow contract is actually holding right now.
   *
   * This summed every escrow the client had ever created, at its full original
   * amount — so cancelling a job left its budget in the total forever, and the
   * headline figure contradicted the list directly underneath it: 13.00 USDC
   * above a single 5 USDC job.
   *
   * Two corrections. Settled jobs are excluded, because their money has already
   * gone to the freelancer or come back. And what has been released along the
   * way is subtracted from the jobs still running, because a milestone that has
   * been paid is not sitting in escrow either.
   */
  const totalValue = escrows.reduce((sum, escrow) => {
    if (SETTLED.has(escrow.status)) return sum;
    const held =
      Number.parseFloat(escrow.totalAmount) - Number.parseFloat(escrow.releasedAmount);
    return sum + Math.max(0, held) / 1e6;
  }, 0);

  /*
   * Released stays a lifetime total on purpose. "What has this client paid out"
   * is a real question, and unlike the figure above it does not go stale — a
   * finished job's payment did happen.
   */
  const totalReleased = escrows.reduce(
    (sum, escrow) => sum + Number.parseFloat(escrow.releasedAmount) / 1e6,
    0
  );

  // Helper function to check if an escrow is terminated (has disputed, rejected, or resolved milestones)
  const isEscrowTerminated = (escrow: any) => {
    return escrow.milestones.some(
      (milestone: any) =>
        milestone.status === "disputed" ||
        milestone.status === "rejected" ||
        milestone.status === "resolved"
    );
  };

  // Count active projects (excluding terminated ones)
  const activeProjects = escrows.filter(
    (escrow) => escrow.status === "active" && !isEscrowTerminated(escrow)
  ).length;

  // const completedProjects = escrows.filter(
  //   (escrow) => escrow.status === "completed"
  // ).length; // Unused

  // Count disputed projects (including terminated ones)
  const disputedProjects = escrows.filter(
    (escrow) => escrow.status === "disputed" || isEscrowTerminated(escrow)
  ).length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
      <Card className="glass border-primary/20 p-4 md:p-6">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Value</CardTitle>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalValue.toFixed(2)} USDC</div>
          <p className="text-xs text-muted-foreground">USDC in escrows</p>
        </CardContent>
      </Card>

      <Card className="glass border-accent/20 p-4 md:p-6">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Released</CardTitle>
          <FileText className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalReleased.toFixed(2)} USDC</div>
          <p className="text-xs text-muted-foreground">USDC released</p>
        </CardContent>
      </Card>

      <Card className="glass border-primary/20 p-4 md:p-6">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Active</CardTitle>
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{activeProjects}</div>
          <p className="text-xs text-muted-foreground">projects</p>
        </CardContent>
      </Card>

      <Card className="glass border-primary/20 p-4 md:p-6">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Disputed</CardTitle>
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{disputedProjects}</div>
          <p className="text-xs text-muted-foreground">projects</p>
        </CardContent>
      </Card>
    </div>
  );
}
