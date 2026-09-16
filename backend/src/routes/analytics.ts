import { Router } from "express";
import { createPublicClient, http, formatUnits } from "viem";

const router = Router();

// Arc EVM Testnet configuration
const ARC_TESTNET_RPC = process.env.ARC_RPC_URL || "https://rpc-testnet.arc.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}`;

// USDC uses 6 decimals, not 18 like ETH
const USDC_DECIMALS = 6;

const publicClient = createPublicClient({
  transport: http(ARC_TESTNET_RPC),
});

// Contract ABI - only the functions we need for analytics
const ATELIER_ABI = [
  {
    inputs: [],
    name: "nextEscrowId",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "escrowId", type: "uint256" }],
    name: "getEscrow",
    outputs: [
      {
        components: [
          { name: "depositor", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "token", type: "address" },
          { name: "totalAmount", type: "uint256" },
          { name: "paidAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "workStarted", type: "bool" },
          { name: "platformFee", type: "uint256" },
          { name: "arbiters", type: "address[]" },
          { name: "requiredConfirmations", type: "uint256" },
          { name: "isOpenJob", type: "bool" },
          { name: "projectTitle", type: "string" },
          { name: "projectDescription", type: "string" },
        ],
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "addr", type: "address" }],
    name: "completedEscrows",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "addr", type: "address" }],
    name: "reputation",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "addr", type: "address" }],
    name: "getAverageRating",
    outputs: [
      { name: "averageX100", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "escrowId", type: "uint256" }],
    name: "getMilestones",
    outputs: [
      {
        components: [
          { name: "description", type: "string" },
          { name: "amount", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "submittedAt", type: "uint256" },
          { name: "approvedAt", type: "uint256" },
          { name: "rejectionReason", type: "string" },
          { name: "proposedAmount", type: "uint256" },
          { name: "proposedDescription", type: "string" },
          { name: "proposalStatus", type: "uint8" },
        ],
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * GET /v1/analytics/platform
 * Returns platform-wide statistics
 */
router.get("/platform", async (req, res) => {
  try {
    if (!CONTRACT_ADDRESS) {
      return res.status(500).json({ error: "Contract address not configured" });
    }

    // Get total number of escrows
    const nextEscrowId = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: ATELIER_ABI,
      functionName: "nextEscrowId",
    });

    const totalEscrows = Number(nextEscrowId) - 1;

    // Fetch all escrows to calculate statistics
    let totalVolume = BigInt(0);
    let activeEscrows = 0;
    let completedEscrows = 0;
    let disputedEscrows = 0;
    let totalFees = BigInt(0);

    const escrowPromises = [];
    for (let i = 1; i <= totalEscrows; i++) {
      escrowPromises.push(
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: ATELIER_ABI,
          functionName: "getEscrow",
          args: [BigInt(i)],
        })
      );
    }

    const escrows = await Promise.all(escrowPromises);

    for (const escrow of escrows) {
      if (!escrow || !escrow.depositor || escrow.depositor === "0x0000000000000000000000000000000000000000") {
        continue;
      }

      // Add total amount to volume (all escrows contribute to volume)
      totalVolume += escrow.totalAmount;
      totalFees += escrow.platformFee;

      // Status: 0=Pending, 1=Active/InProgress, 2=Completed, 3=Refunded, 4=Disputed, 5=Expired, 6=Cancelled
      if (escrow.status === 1 || escrow.status === 0) activeEscrows++; // Active or Pending with work started
      if (escrow.status === 2) completedEscrows++; // Completed
      if (escrow.status === 4) disputedEscrows++; // Disputed
    }

    const analytics = {
      totalEscrows,
      activeEscrows,
      completedEscrows,
      disputedEscrows,
      totalVolume: formatUnits(totalVolume, USDC_DECIMALS),
      totalVolumeWei: totalVolume.toString(),
      totalFees: formatUnits(totalFees, USDC_DECIMALS),
      totalFeesWei: totalFees.toString(),
      completionRate: totalEscrows > 0 ? ((completedEscrows / totalEscrows) * 100).toFixed(2) : "0",
      disputeRate: totalEscrows > 0 ? ((disputedEscrows / totalEscrows) * 100).toFixed(2) : "0",
    };

    res.json(analytics);
  } catch (error: any) {
    console.error("Analytics error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch analytics" });
  }
});

/**
 * GET /v1/analytics/user/:address
 * Returns user-specific statistics
 */
router.get("/user/:address", async (req, res) => {
  try {
    if (!CONTRACT_ADDRESS) {
      return res.status(500).json({ error: "Contract address not configured" });
    }

    const userAddress = req.params.address as `0x${string}`;

    if (!userAddress || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({ error: "Invalid address format" });
    }

    // Get user's completed escrows count
    const completedCount = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: ATELIER_ABI,
      functionName: "completedEscrows",
      args: [userAddress],
    });

    // Get user's reputation
    const reputation = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: ATELIER_ABI,
      functionName: "reputation",
      args: [userAddress],
    });

    // Get user's average rating
    const [averageX100, ratingCount] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: ATELIER_ABI,
      functionName: "getAverageRating",
      args: [userAddress],
    });

    // Get total number of escrows to scan
    const nextEscrowId = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: ATELIER_ABI,
      functionName: "nextEscrowId",
    });

    const totalEscrows = Number(nextEscrowId) - 1;

    // Fetch user's escrows
    let asClient = 0;
    let asFreelancer = 0;
    let totalEarned = BigInt(0);
    let totalSpent = BigInt(0);
    let activeProjects = 0;

    const escrowPromises = [];
    for (let i = 1; i <= totalEscrows; i++) {
      escrowPromises.push(
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: ATELIER_ABI,
          functionName: "getEscrow",
          args: [BigInt(i)],
        })
      );
    }

    const escrows = await Promise.all(escrowPromises);

    for (const escrow of escrows) {
      if (!escrow || !escrow.depositor || escrow.depositor === "0x0000000000000000000000000000000000000000") {
        continue;
      }

      const isClient = escrow.depositor.toLowerCase() === userAddress.toLowerCase();
      const isFreelancer = escrow.beneficiary.toLowerCase() === userAddress.toLowerCase();

      if (!isClient && !isFreelancer) continue;

      if (isClient) {
        asClient++;
        // Client's total spent is the total amount they deposited (including fees)
        totalSpent += escrow.totalAmount;
        // Count as active if status is Pending (0) or Active (1)
        if (escrow.status === 0 || escrow.status === 1) activeProjects++;
      }

      if (isFreelancer) {
        asFreelancer++;
        // Freelancer's earnings are what has been paid out to them
        console.log(`[Analytics] Escrow for freelancer ${userAddress}: paidAmount=${escrow.paidAmount.toString()}, totalAmount=${escrow.totalAmount.toString()}, status=${escrow.status}`);
        totalEarned += escrow.paidAmount;
        // Count as active if status is Pending (0) or Active (1)
        if (escrow.status === 0 || escrow.status === 1) activeProjects++;
      }
    }

    console.log(`[Analytics] User ${userAddress} totals: totalEarned=${totalEarned.toString()} (${formatUnits(totalEarned, USDC_DECIMALS)} USDC), asFreelancer=${asFreelancer}, totalSpent=${totalSpent.toString()}, asClient=${asClient}`);

    const userStats = {
      address: userAddress,
      completedEscrows: Number(completedCount),
      reputation: Number(reputation),
      averageRating: Number(averageX100) / 100,
      ratingCount: Number(ratingCount),
      projectsAsClient: asClient,
      projectsAsFreelancer: asFreelancer,
      totalEarned: formatUnits(totalEarned, USDC_DECIMALS),
      totalEarnedWei: totalEarned.toString(),
      totalSpent: formatUnits(totalSpent, USDC_DECIMALS),
      totalSpentWei: totalSpent.toString(),
      activeProjects,
    };

    res.json(userStats);
  } catch (error: any) {
    console.error("User analytics error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch user analytics" });
  }
});

/**
 * GET /v1/analytics/trends
 * Returns trend data (escrows created over time)
 */
router.get("/trends", async (req, res) => {
  try {
    if (!CONTRACT_ADDRESS) {
      return res.status(500).json({ error: "Contract address not configured" });
    }

    // Get total number of escrows
    const nextEscrowId = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: ATELIER_ABI,
      functionName: "nextEscrowId",
    });

    const totalEscrows = Number(nextEscrowId) - 1;

    // For simplicity, we'll return escrow counts by status
    // In a production app, you'd want to track creation timestamps
    const statusCounts = {
      pending: 0,
      inProgress: 0,
      completed: 0,
      refunded: 0,
      disputed: 0,
      expired: 0,
      cancelled: 0,
    };

    const escrowPromises = [];
    for (let i = 1; i <= totalEscrows; i++) {
      escrowPromises.push(
        publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: ATELIER_ABI,
          functionName: "getEscrow",
          args: [BigInt(i)],
        })
      );
    }

    const escrows = await Promise.all(escrowPromises);

    for (const escrow of escrows) {
      if (!escrow || !escrow.depositor || escrow.depositor === "0x0000000000000000000000000000000000000000") {
        continue;
      }

      switch (escrow.status) {
        case 0:
          statusCounts.pending++;
          break;
        case 1:
          statusCounts.inProgress++;
          break;
        case 2:
          statusCounts.completed++;
          break;
        case 3:
          statusCounts.refunded++;
          break;
        case 4:
          statusCounts.disputed++;
          break;
        case 5:
          statusCounts.expired++;
          break;
        case 6:
          statusCounts.cancelled++;
          break;
      }
    }

    res.json({
      totalEscrows,
      statusDistribution: statusCounts,
    });
  } catch (error: any) {
    console.error("Trends error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch trends" });
  }
});

export { router as analyticsRouter };
