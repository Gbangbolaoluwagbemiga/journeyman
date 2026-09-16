import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";
import {
  TrendingUp,
  DollarSign,
  Users,
  Activity,
  Award,
  Briefcase,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface PlatformAnalytics {
  totalEscrows: number;
  activeEscrows: number;
  completedEscrows: number;
  disputedEscrows: number;
  totalVolumeUsdc: string;
  totalVolumeEth: string;
  totalFeesUsdc: string;
  totalFeesEth: string;
  completionRate: string;
  disputeRate: string;
}

interface UserAnalytics {
  address: string;
  completedEscrows: number;
  reputation: number;
  averageRating: number;
  ratingCount: number;
  projectsAsClient: number;
  projectsAsFreelancer: number;
  totalEarned: string;
  totalSpent: string;
  activeProjects: number;
  cancelledProjects: number;
}

interface TrendsData {
  totalEscrows: number;
  statusDistribution: {
    pending: number;
    inProgress: number;
    completed: number;
    refunded: number;
    disputed: number;
    expired: number;
    cancelled: number;
  };
}

const COLORS = {
  pending: "#8b5cf6",      // Purple
  inprogress: "#06b6d4",   // Cyan
  completed: "#10b981",    // Green
  refunded: "#f59e0b",     // Orange
  disputed: "#ef4444",     // Red
  expired: "#6366f1",      // Indigo
  cancelled: "#ec4899",    // Pink
};

export default function AnalyticsPage() {
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const [platformData, setPlatformData] = useState<PlatformAnalytics | null>(null);
  const [userData, setUserData] = useState<UserAnalytics | null>(null);
  const [trendsData, setTrendsData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchAnalytics();
  }, [wallet.address]);

  const fetchAnalytics = async () => {
    setRefreshing(true);
    try {
      // Fetch analytics directly from blockchain
      const { ContractService } = await import("@/lib/web3/contract-service");
      const { CONTRACTS } = await import("@/lib/web3/config");
      const cs = new ContractService(CONTRACTS.ATELIER_ESCROW);

      // Get next escrow ID to know how many escrows exist
      const nextEscrowId = await cs.getNextEscrowId();
      const totalEscrows = nextEscrowId - 1;

      const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
      const USDC_ADDRESS = (
        (import.meta.env.VITE_USDC_TOKEN_CONTRACT as string | undefined)?.trim() || NATIVE_ETH
      ).toLowerCase();

      // Needed to recover original work value from escrow.platformFee, since
      // the contract decrements escrow.totalAmount on dispute client refunds.
      const platformFeeBP = await cs.getPlatformFeeBP();

      let activeEscrows = 0;
      let completedEscrows = 0;
      let disputedEscrows = 0;
      let totalVolumeUsdcRaw = 0n;
      let totalVolumeEthRaw = 0n;
      const statusDistribution = {
        pending: 0,
        inProgress: 0,
        completed: 0,
        refunded: 0,
        disputed: 0,
        expired: 0,
        cancelled: 0,
      };

      // Iterate through all escrows to calculate stats
      // Batched via multicall3 (single round trip) instead of one RPC call
      // per escrow — sequential per-ID reads were silently dropping escrows
      // from every breakdown metric whenever an individual call failed or
      // got rate-limited, while totalEscrows (from the raw ID counter)
      // stayed correct — causing the two numbers on this page to diverge.
      const ids = Array.from({ length: Math.max(0, nextEscrowId - 1) }, (_, k) => k + 1);
      const escrowBatch = await cs.getEscrowsBatch(ids);
      const milestonesBatch = await cs.getMilestonesBatch(ids);

      for (const i of ids) {
        try {
          const escrow = escrowBatch[i];
          if (!escrow) continue;

          const status = escrow.status || 0;
          const escrowToken = (escrow.token || NATIVE_ETH).toLowerCase();
          // Recover original (pre-dispute-refund) work value:
          //   platformFee = originalTotal * platformFeeBP / 10000
          //   so originalTotal = platformFee * 10000 / platformFeeBP
          const platformFee = BigInt(escrow.platformFee || 0);
          const currentTotal = BigInt(escrow.totalAmount || 0);
          const amount =
            platformFeeBP > 0 && platformFee > 0n
              ? (platformFee * 10000n) / BigInt(platformFeeBP)
              : currentTotal;
          if (escrowToken === USDC_ADDRESS) {
            totalVolumeUsdcRaw += amount;
          } else {
            totalVolumeEthRaw += amount;
          }

          // Check if any milestone is disputed or resolved
          let hasDisputedMilestone = false;
          const milestones = milestonesBatch[i] ?? [];
          for (const m of milestones) {
            const milestoneStatus = Number(m.status || 0);
            // Status 4 = Disputed, or resolvedAt > 0 means it was disputed and resolved by admin
            if (milestoneStatus === 4 || (m.resolvedAt && BigInt(m.resolvedAt) > 0n)) {
              hasDisputedMilestone = true;
              break;
            }
          }

          // Count by status - if has disputed milestone, count as disputed regardless of escrow status
          if (hasDisputedMilestone) {
            disputedEscrows++;
            statusDistribution.disputed++;
          } else {
            switch (status) {
              case 0:
                statusDistribution.pending++;
                break;
              case 1:
                activeEscrows++;
                statusDistribution.inProgress++;
                break;
              case 2:
                completedEscrows++;
                statusDistribution.completed++;
                break;
              case 3:
                statusDistribution.refunded++;
                break;
              case 4:
                disputedEscrows++;
                statusDistribution.disputed++;
                break;
              case 5:
                statusDistribution.expired++;
                break;
              case 6:
                statusDistribution.cancelled++;
                break;
            }
          }
        } catch (error) {
          // Skip escrows that can't be read
          continue;
        }
      }

      // Calculate completion rate
      const completionRate = totalEscrows > 0 
        ? ((completedEscrows / totalEscrows) * 100).toFixed(2)
        : "0.00";

      // Calculate dispute rate
      const disputeRate = totalEscrows > 0
        ? ((disputedEscrows / totalEscrows) * 100).toFixed(2)
        : "0.00";

      // Read platform fees per token. USDC is 6 decimals, native ETH is 18.
      let totalFeesUsdcRaw = 0n;
      let totalFeesEthRaw = 0n;
      try {
        if (USDC_ADDRESS !== NATIVE_ETH) {
          totalFeesUsdcRaw = BigInt(await cs.getTotalFeesByToken(USDC_ADDRESS));
        }
        totalFeesEthRaw = BigInt(await cs.getTotalFeesByToken(NATIVE_ETH));
      } catch {
        /* fee read failed — keep zeros */
      }

      const formatUsdc = (raw: bigint) => (Number(raw) / 1e6).toFixed(2);
      const formatEth = (raw: bigint) => (Number(raw) / 1e18).toFixed(6);

      const platformAnalytics: PlatformAnalytics = {
        totalEscrows,
        activeEscrows,
        completedEscrows,
        disputedEscrows,
        totalVolumeUsdc: formatUsdc(totalVolumeUsdcRaw),
        totalVolumeEth: formatEth(totalVolumeEthRaw),
        totalFeesUsdc: formatUsdc(totalFeesUsdcRaw),
        totalFeesEth: formatEth(totalFeesEthRaw),
        completionRate,
        disputeRate,
      };

      setPlatformData(platformAnalytics);
      setTrendsData({
        totalEscrows,
        statusDistribution,
      });

      // Fetch user analytics if wallet is connected
      if (wallet.address) {
        try {
          const userEscrows = await cs.getUserEscrows(wallet.address);
          let userCompletedEscrows = 0;
          let userTotalEarned = 0n;
          let userTotalSpent = 0n;
          let userActiveProjects = 0;
          let userProjectsAsClient = 0;
          let userProjectsAsFreelancer = 0;
          let userCancelledProjects = 0;

          for (const escrowId of userEscrows) {
            try {
              const escrow = await cs.getEscrow(escrowId);
              if (!escrow) continue;

              const isClient = escrow.depositor?.toLowerCase() === wallet.address.toLowerCase();
              const isFreelancer = escrow.beneficiary?.toLowerCase() === wallet.address.toLowerCase();

              if (isClient) {
                userProjectsAsClient++;
                userTotalSpent += BigInt(escrow.totalAmount || 0);
              }
              if (isFreelancer) {
                userProjectsAsFreelancer++;
                userTotalEarned += BigInt(escrow.paidAmount || 0);
              }

              if (escrow.status === 1) {
                userActiveProjects++;
              } else if (escrow.status === 2) {
                userCompletedEscrows++;
              } else if (escrow.status === 6) {
                userCancelledProjects++;
              }
            } catch (error) {
              continue;
            }
          }

          // Get user rating
          const { averageX100, count } = await cs.getAverageRating(wallet.address);
          const averageRating = averageX100 / 100;

          const userAnalytics: UserAnalytics = {
            address: wallet.address,
            completedEscrows: userCompletedEscrows,
            reputation: userCompletedEscrows * 10, // Simple reputation calculation
            averageRating,
            ratingCount: count,
            projectsAsClient: userProjectsAsClient,
            projectsAsFreelancer: userProjectsAsFreelancer,
            totalEarned: (userTotalEarned / BigInt(1e6)).toString(),
            totalSpent: (userTotalSpent / BigInt(1e6)).toString(),
            activeProjects: userActiveProjects,
            cancelledProjects: userCancelledProjects,
          };

          setUserData(userAnalytics);
        } catch (error) {
          console.error("Failed to fetch user analytics:", error);
        }
      }
    } catch (error: any) {
      toast({
        title: "Failed to load analytics",
        description: error.message || "Could not fetch analytics data",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    fetchAnalytics();
  };

  if (loading) {
    return (
      <div className="min-h-screen py-12 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading analytics...</p>
        </div>
      </div>
    );
  }

  const statusChartData = trendsData
    ? Object.entries(trendsData.statusDistribution)
        .filter(([_, value]) => value > 0) // Only show statuses with values
        .map(([name, value]) => ({
          name: name.charAt(0).toUpperCase() + name.slice(1).replace(/([A-Z])/g, ' $1'),
          value,
          key: name.toLowerCase(),
        }))
    : [];

  return (
    <div className="min-h-screen py-12">
      <div className="container mx-auto px-4">
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-4xl md:text-5xl font-bold mb-2">Analytics Dashboard</h1>
            <p className="text-xl text-muted-foreground">
              Platform metrics and user statistics
            </p>
          </div>
          <Button
            variant="outline"
            size="default"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Tabs defaultValue="platform" className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 lg:w-[400px]">
            <TabsTrigger value="platform">Platform</TabsTrigger>
            <TabsTrigger value="user" disabled={!wallet.isConnected}>
              My Stats
            </TabsTrigger>
          </TabsList>

          <TabsContent value="platform" className="space-y-6">
            {/* Platform Overview Cards */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Escrows</p>
                    <h3 className="text-3xl font-bold mt-2">
                      {platformData?.totalEscrows || 0}
                    </h3>
                  </div>
                  <Briefcase className="h-8 w-8 text-primary" />
                </div>
              </Card>

              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Active Projects</p>
                    <h3 className="text-3xl font-bold mt-2">
                      {platformData?.activeEscrows || 0}
                    </h3>
                  </div>
                  <Activity className="h-8 w-8 text-cyan-500" />
                </div>
              </Card>

              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Total Volume</p>
                    <h3 className="text-3xl font-bold mt-2">
                      {platformData?.totalVolumeUsdc ?? "0.00"} USDC
                    </h3>
                    {platformData && parseFloat(platformData.totalVolumeEth) > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        + {platformData.totalVolumeEth} ETH
                      </p>
                    )}
                  </div>
                  <DollarSign className="h-8 w-8 text-green-500" />
                </div>
              </Card>

              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Completion Rate</p>
                    <h3 className="text-3xl font-bold mt-2">
                      {platformData?.completionRate || 0}%
                    </h3>
                  </div>
                  <TrendingUp className="h-8 w-8 text-purple-500" />
                </div>
              </Card>
            </div>

            {/* Charts */}
            <div className="grid gap-6 md:grid-cols-2">
              {/* Status Distribution Pie Chart */}
              <Card className="glass border-primary/20 p-6">
                <h3 className="text-xl font-bold mb-4">Escrow Status Distribution</h3>
                {statusChartData.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={250}>
                      <PieChart>
                        <Pie
                          data={statusChartData}
                          cx="50%"
                          cy="50%"
                          labelLine={true}
                          label={({ name, value, percent }: any) =>
                            value > 0 ? `${name}: ${value} (${((percent as number) * 100).toFixed(0)}%)` : ''
                          }
                          outerRadius={80}
                          fill="#8884d8"
                          dataKey="value"
                        >
                          {statusChartData.map((entry: any) => (
                            <Cell 
                              key={`cell-${entry.key}`} 
                              fill={COLORS[entry.key as keyof typeof COLORS] || "#8b5cf6"} 
                            />
                          ))}
                        </Pie>
                        <Tooltip 
                          formatter={(value: number) => [`${value} escrows`, 'Count']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                      {statusChartData.map((entry: any) => (
                        <div key={entry.key} className="flex items-center gap-2">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: COLORS[entry.key as keyof typeof COLORS] || "#8b5cf6" }}
                          />
                          <span className="text-muted-foreground">
                            {entry.name}: <span className="font-semibold text-foreground">{entry.value}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                    No escrow data available
                  </div>
                )}
              </Card>

              {/* Platform Metrics Bar Chart */}
              <Card className="glass border-primary/20 p-6">
                <h3 className="text-xl font-bold mb-4">Platform Metrics</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={[
                      {
                        name: "Metrics",
                        Active: platformData?.activeEscrows || 0,
                        Completed: platformData?.completedEscrows || 0,
                        Disputed: platformData?.disputedEscrows || 0,
                      },
                    ]}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Active" fill="#06b6d4" />
                    <Bar dataKey="Completed" fill="#10b981" />
                    <Bar dataKey="Disputed" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </div>

            {/* Additional Stats */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-full bg-green-500/10">
                    <TrendingUp className="h-6 w-6 text-green-500" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Completed</p>
                    <p className="text-2xl font-bold">{platformData?.completedEscrows || 0}</p>
                  </div>
                </div>
              </Card>

              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-full bg-red-500/10">
                    <Activity className="h-6 w-6 text-red-500" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Dispute Rate</p>
                    <p className="text-2xl font-bold">{platformData?.disputeRate || 0}%</p>
                  </div>
                </div>
              </Card>

              <Card className="glass border-primary/20 p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-full bg-purple-500/10">
                    <DollarSign className="h-6 w-6 text-purple-500" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Platform Fees</p>
                    <p className="text-2xl font-bold">
                      {platformData?.totalFeesUsdc ?? "0.00"} USDC
                    </p>
                    {platformData && parseFloat(platformData.totalFeesEth) > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        + {platformData.totalFeesEth} ETH
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="user" className="space-y-6">
            {userData && (
              <>
                {/* User Overview Cards */}
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <Card className="glass border-primary/20 p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Reputation</p>
                        <h3 className="text-3xl font-bold mt-2">{userData.reputation}</h3>
                      </div>
                      <Award className="h-8 w-8 text-yellow-500" />
                    </div>
                  </Card>

                  <Card className="glass border-primary/20 p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">
                          Average Rating
                        </p>
                        <h3 className="text-3xl font-bold mt-2">
                          {userData.averageRating.toFixed(1)} ⭐
                        </h3>
                        <p className="text-xs text-muted-foreground mt-1">
                          {userData.ratingCount} ratings
                        </p>
                      </div>
                      <Users className="h-8 w-8 text-purple-500" />
                    </div>
                  </Card>

                  <Card className="glass border-primary/20 p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Total Earned</p>
                        <h3 className="text-3xl font-bold mt-2">
                          {parseFloat(userData.totalEarned).toFixed(2)} USDC
                        </h3>
                      </div>
                      <DollarSign className="h-8 w-8 text-green-500" />
                    </div>
                  </Card>

                  <Card className="glass border-primary/20 p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Active Projects</p>
                        <h3 className="text-3xl font-bold mt-2">{userData.activeProjects}</h3>
                      </div>
                      <Activity className="h-8 w-8 text-cyan-500" />
                    </div>
                  </Card>

                  <Card className="glass border-primary/20 p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Cancelled Projects</p>
                        <h3 className="text-3xl font-bold mt-2">{userData.cancelledProjects}</h3>
                      </div>
                      <AlertCircle className="h-8 w-8 text-red-500" />
                    </div>
                  </Card>
                </div>

                {/* User Activity Chart */}
                <Card className="glass border-primary/20 p-6">
                  <h3 className="text-xl font-bold mb-4">Your Activity</h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart
                      data={[
                        {
                          name: "Projects",
                          "As Client": userData.projectsAsClient,
                          "As Freelancer": userData.projectsAsFreelancer,
                          Completed: userData.completedEscrows,
                        },
                      ]}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="As Client" fill="#8b5cf6" />
                      <Bar dataKey="As Freelancer" fill="#06b6d4" />
                      <Bar dataKey="Completed" fill="#10b981" />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>

                {/* Financial Overview */}
                <div className="grid gap-4 md:grid-cols-2">
                  <Card className="glass border-primary/20 p-6">
                    <h3 className="text-lg font-bold mb-4">Earnings Overview</h3>
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Total Earned</span>
                        <span className="font-bold">
                          {parseFloat(userData.totalEarned).toFixed(4)} USDC
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Projects as Freelancer</span>
                        <span className="font-bold">{userData.projectsAsFreelancer}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Completed Projects</span>
                        <span className="font-bold">{userData.completedEscrows}</span>
                      </div>
                    </div>
                  </Card>

                  <Card className="glass border-primary/20 p-6">
                    <h3 className="text-lg font-bold mb-4">Spending Overview</h3>
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Total Spent</span>
                        <span className="font-bold">
                          {parseFloat(userData.totalSpent).toFixed(4)} USDC
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Projects as Client</span>
                        <span className="font-bold">{userData.projectsAsClient}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Active Projects</span>
                        <span className="font-bold">{userData.activeProjects}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Cancelled Projects</span>
                        <span className="font-bold text-red-600">{userData.cancelledProjects}</span>
                      </div>
                    </div>
                  </Card>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
