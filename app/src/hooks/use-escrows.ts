import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { encodeJobId } from "@/lib/id-codec";
import { useWriteContract, useReadContract } from "wagmi";
import { contractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";
import AtelierABI from "@/lib/web3/AtelierABI.json";
import useWalletStore from "@/store/wallet.store";
import { toast } from "@/hooks/use-toast";
import { erc20Abi } from "@/lib/web3/abis";
import {
  cacheOriginalDescriptions,
  markRecoveryAttempted,
} from "@/lib/milestone-cache";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function contractAddr() {
  const addr = CONTRACTS.ATELIER_ESCROW;
  if (!addr) throw new Error("VITE_ATELIER_CONTRACT_ADDRESS is not set");
  return addr as `0x${string}`;
}

export function useEscrow(escrowId: number | null) {
  return useQuery({
    queryKey: ["escrow", escrowId],
    queryFn: () => {
      if (!escrowId) throw new Error("Escrow ID is required");
      return contractService.getEscrow(escrowId);
    },
    enabled: !!escrowId,
    staleTime: 30_000,
  });
}

export function useUserEscrows() {
  const { address } = useWalletStore();
  return useQuery({
    queryKey: ["user-escrows", address],
    queryFn: () => {
      if (!address) throw new Error("Wallet not connected");
      return contractService.getUserEscrows(address);
    },
    enabled: !!address,
    staleTime: 30_000,
  });
}

export function useEscrows(escrowIds: number[]) {
  return useQuery({
    queryKey: ["escrows", escrowIds],
    queryFn: async () => {
      // Single multicall round trip instead of N sequential RPCs
      const batch = await contractService.getEscrowsBatch(escrowIds);
      return escrowIds.map((id) => batch[id]).filter(Boolean);
    },
    enabled: escrowIds.length > 0,
    staleTime: 30_000,
  });
}

export function useCreateEscrow() {
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: {
      depositor: string;
      beneficiary?: string;
      arbiters: string[];
      required_confirmations: number;
      milestones: Array<[string, string]>; // [amount_wei, description]
      token?: string;
      total_amount: string;  // in wei
      duration: number;      // in seconds
      project_title: string;
      project_description: string;
      /**
       * Whether the client already set their work intent on the controller.
       *
       * The contract waives the platform fee for such a job, but quoteDeposit
       * cannot know that — it is a pure function of the amount, with no idea
       * who is asking or what they intend. Without this the approval asked for
       * budget + fee while the review screen promised budget alone, and a
       * client watching their wallet contradict the page they had just read
       * concluded, reasonably, that something was out of sync.
       */
      put_to_work?: boolean;
    }) => {
      if (!params.depositor) throw new Error("Wallet not connected");

      const totalAmount = BigInt(params.total_amount);
      
      // Validate total amount
      if (totalAmount === 0n) {
        throw new Error("Total amount cannot be 0. Please enter a valid amount.");
      }

      const durationDays = BigInt(Math.max(1, Math.round(params.duration / 86400)));
      
      const token = (params.token && params.token.trim() !== "" 
        ? params.token 
        : ZERO_ADDRESS) as `0x${string}`;
      
      const beneficiary = (params.beneficiary || ZERO_ADDRESS) as `0x${string}`;
      const arbiters = (params.arbiters || []) as `0x${string}`[];
      const requiredConfirmations = BigInt(params.required_confirmations || 1);
      const milestoneAmounts = params.milestones.map(([amt]) => BigInt(amt));
      const milestoneDescriptions = params.milestones.map(([, desc]) => desc);

      // Validate milestone amounts
      const milestoneSum = milestoneAmounts.reduce((sum, amt) => sum + amt, 0n);
      
      if (milestoneSum !== totalAmount) {
        throw new Error(`Milestone amounts (${milestoneSum}) do not equal total amount (${totalAmount})`);
      }

      // Exact deposit from the contract, minus the fee it is about to waive.
      const { deposit: quoted } = await contractService.quoteDeposit(totalAmount);
      const deposit = params.put_to_work ? totalAmount : quoted;

      if (deposit === 0n) {
        throw new Error("Deposit amount is 0. Please check your input amounts.");
      }

      const isNativeToken = token === ZERO_ADDRESS;

      // For ERC-20 tokens: check allowance and approve if needed
      if (!isNativeToken) {
        const escrowAddr = contractAddr();
        
        // Read current allowance
        const { createPublicClient, http } = await import("viem");
        const { arcTestnet } = await import("@/providers/WalletProvider");
        const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
        
        try {
          const allowance = await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [params.depositor as `0x${string}`, escrowAddr],
          }) as bigint;

          if (allowance < deposit) {
            // Show approval required message
            toast({ 
              title: "Token Approval Required", 
              description: "Please approve the token transfer in your wallet. A popup will appear shortly." 
            });
            
            // Small delay to ensure toast is visible before wallet popup
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Trigger approval transaction - this will show wallet popup
            let approvalHash: string;
            try {
              approvalHash = await writeContractAsync({
                address: token,
                abi: erc20Abi,
                functionName: "approve",
                args: [escrowAddr, deposit],
              });
            } catch (walletError: any) {
              const errorMsg = walletError?.message || "Wallet error";
              if (errorMsg.includes("User rejected") || errorMsg.includes("user rejected")) {
                throw new Error("You rejected the token approval. Please try again and approve the transaction.");
              }
              throw new Error(`Token approval failed: ${errorMsg}`);
            }
            
            // Wait for approval to be mined
            try {
              const approvalReceipt = await publicClient.waitForTransactionReceipt({ 
                hash: approvalHash as `0x${string}`,
                timeout: 120_000,
                pollingInterval: 1_000,
              });
              
              if (approvalReceipt.status !== "success") {
                throw new Error("Token approval transaction failed - please try again");
              }
              
              toast({ 
                title: "Token Approved Successfully", 
                description: "Your tokens have been approved. Creating escrow..." 
              });
            } catch (receiptError: any) {
              const errorMsg = receiptError?.message || "Failed to confirm approval";
              throw new Error(`Approval confirmation failed: ${errorMsg}`);
            }
          }
        } catch (approvalError: any) {
          const errorMsg = approvalError?.message || "Token approval failed";
          throw new Error(errorMsg);
        }
      }

      const hash = await writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "createEscrow",
        args: [
          beneficiary,
          token,
          totalAmount,
          durationDays,
          arbiters,
          requiredConfirmations,
          milestoneAmounts,
          milestoneDescriptions,
          params.project_title,
          params.project_description,
        ],
        value: isNativeToken ? deposit : 0n,
      });

      // Wait for transaction to be mined and get the receipt
      const { createPublicClient, http, decodeEventLog } = await import("viem");
      const { arcTestnet } = await import("@/providers/WalletProvider");
      const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
      
      toast({ title: "Transaction submitted", description: "Waiting for confirmation..." });
      
      // Wait for transaction with a longer timeout (2 minutes) for testnet
      const receipt = await publicClient.waitForTransactionReceipt({ 
        hash,
        timeout: 120_000, // 2 minutes timeout
        pollingInterval: 1_000, // Poll every 1 second
      });
      
      if (receipt.status === "reverted") {
        throw new Error("Transaction failed - please check your balance and try again");
      }

      // Extract escrow ID from logs
      let escrowId: string | undefined;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: AtelierABI.abi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "EscrowCreated") {
            escrowId = (decoded.args as any).escrowId?.toString();
            break;
          }
        } catch (e) {
          // Continue to next log
        }
      }

      // Snapshot the original milestone descriptions now — the contract will
      // overwrite Milestone.description on submitMilestone(), so this is the
      // last chance to capture them from the client's input cleanly. Also
      // mark the recovery sentinel so we don't waste an RPC trip later.
      if (escrowId && escrowId !== "unknown") {
        cacheOriginalDescriptions(escrowId, milestoneDescriptions);
        markRecoveryAttempted(escrowId);
      }

      return { hash, escrowId: escrowId || "unknown" };
    },
    onSuccess: async (data, params) => {
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      queryClient.invalidateQueries({ queryKey: ["escrows"] });
      toast({
        title: "Escrow created",
        description: data.escrowId !== "unknown"
          ? `${encodeJobId(data.escrowId)} created successfully`
          : "Your escrow was created successfully"
      });

      // Notify a directly-assigned freelancer (non-zero beneficiary set at creation).
      // Open-job freelancers are notified separately when the client accepts them.
      const directBeneficiary = params.beneficiary?.trim();
      if (
        directBeneficiary &&
        directBeneficiary !== ZERO_ADDRESS &&
        directBeneficiary !== "0x"
      ) {
        try {
          const { postNotification, isApiConfigured } = await import("@/lib/api");
          if (isApiConfigured()) {
            await postNotification({
              wallet_address: directBeneficiary,
              type: "escrow",
              title: "You've been directly assigned a job",
              message: `A client has assigned you to "${params.project_title || `${encodeJobId(data.escrowId)}`}". Review the milestones on your Freelancer dashboard and start work when ready.`,
              action_url: "/freelancer",
              data: {
                escrowId: data.escrowId,
                projectTitle: params.project_title,
              },
            });
          }
        } catch (e) {
          // Non-fatal — escrow is already created, just log
          console.warn("[atelier] Failed to notify directly assigned freelancer:", e);
        }
      }
    },
    onError: (error: Error) => {
      // Format error message to be more readable
      let errorMessage = error.message || "Failed to create escrow";
      
      // Handle common error patterns
      if (errorMessage.includes("User rejected")) {
        errorMessage = "Transaction cancelled - You rejected the transaction in your wallet";
      } else if (errorMessage.includes("insufficient funds")) {
        errorMessage = "Insufficient funds - Please ensure you have enough USDC and gas";
      } else if (errorMessage.includes("TokenNotWhitelisted")) {
        errorMessage = "Token not whitelisted - Please contact admin to whitelist this token";
      } else if (errorMessage.includes("InvalidAmount")) {
        errorMessage = "Invalid amount - Please check your input amounts";
      } else if (errorMessage.includes("Contract Call")) {
        // Extract readable part from contract call errors
        const match = errorMessage.match(/Contract Call:.*?Error: (.+?)(?:\n|$)/);
        if (match) {
          errorMessage = match[1];
        } else {
          errorMessage = "Transaction failed - Please try again or contact support";
        }
      }
      
      // Remove long hex addresses from error messages
      errorMessage = errorMessage.replace(/0x[a-fA-F0-9]{40,}/g, (match) => {
        return match.substring(0, 10) + "..." + match.substring(match.length - 4);
      });
      
      toast({ 
        title: "Transaction Failed", 
        description: errorMessage, 
        variant: "destructive" 
      });
    },
  });
}

export function useStartWork() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (escrowId: number) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "startWork",
        args: [BigInt(escrowId)],
      });
    },
    onSuccess: async (_, escrowId) => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      
      // Get escrow details for notifications
      try {
        const escrow = await contractService.getEscrow(escrowId);
        if (escrow && address) {
          // Import notification functions
          const { useNotifications, createEscrowNotification } = await import("@/contexts/notification-context");
          
          // Get notification context - we need to do this differently since we're in a hook
          // We'll dispatch a custom event that the notification provider can listen to
          const notificationData = {
            type: "work_started",
            escrowId: escrowId.toString(),
            freelancerAddress: address,
            clientAddress: escrow.depositor,
            projectTitle: escrow.projectTitle || `Project #${escrowId}`,
            freelancerName: `${address.slice(0, 6)}...${address.slice(-4)}`,
          };
          
          // Dispatch custom event for notifications
          window.dispatchEvent(new CustomEvent("workStarted", { detail: notificationData }));
        }
      } catch (error) {
        console.error("Failed to send work started notifications:", error);
      }
      
      toast({ title: "Work started", description: "You have accepted this contract." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to start work", variant: "destructive" });
    },
  });
}

export function useSubmitMilestone() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; milestone_index: number; description: string }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "submitMilestone",
        args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.description],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({ title: "Milestone submitted", description: "Awaiting client review." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to submit milestone", variant: "destructive" });
    },
  });
}

export function useApproveMilestone() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; milestone_index: number }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "approveMilestone",
        args: [BigInt(params.escrow_id), BigInt(params.milestone_index)],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({ title: "Milestone approved", description: "Payment released to freelancer." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to approve milestone", variant: "destructive" });
    },
  });
}

export function useRejectMilestone() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; milestone_index: number; reason: string }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "rejectMilestone",
        args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.reason],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({ title: "Milestone rejected", description: "Freelancer has been notified." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to reject milestone", variant: "destructive" });
    },
  });
}

export function useDisputeMilestone() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; milestone_index: number; reason: string }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "disputeMilestone",
        args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.reason],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({ title: "Dispute raised", description: "An arbiter will review this dispute." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to raise dispute", variant: "destructive" });
    },
  });
}

export function useEmergencyRefund() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (escrowId: number) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "emergencyRefundAfterDeadline",
        args: [BigInt(escrowId)],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({
        title: "Surplus reclaimed",
        description: "Unallocated funds have been returned to your wallet.",
      });
    },
    onError: (error: Error) => {
      let msg = error.message || "Failed to reclaim surplus";
      if (msg.includes("EmergencyPeriodNotReached"))
        msg = "Emergency period not reached yet — wait until 30 days after the deadline.";
      toast({ title: "Reclaim failed", description: msg, variant: "destructive" });
    },
  });
}

export function useApplyToJob() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; cover_letter: string; proposed_timeline: number }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "applyToJob",
        args: [BigInt(params.escrow_id), params.cover_letter, BigInt(params.proposed_timeline)],
      });
    },
    onSuccess: async (_, params) => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      
      // Get escrow details for notifications
      try {
        const escrow = await contractService.getEscrow(params.escrow_id);
        if (escrow && address) {
          // Dispatch custom event for notifications
          const notificationData = {
            jobId: params.escrow_id,
            freelancerAddress: address,
            clientAddress: escrow.depositor,
            jobTitle: escrow.projectTitle || encodeJobId(params.escrow_id),
            freelancerName: `${address.slice(0, 6)}...${address.slice(-4)}`,
            coverLetter: params.cover_letter,
            proposedTimeline: params.proposed_timeline,
          };
          
          // Dispatch custom event for notifications
          window.dispatchEvent(new CustomEvent("jobApplicationSubmitted", { detail: notificationData }));
        }
      } catch (error) {
        console.error("Failed to send job application notifications:", error);
      }
      
      toast({ title: "Application submitted", description: "The client has been notified." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to apply to job", variant: "destructive" });
    },
  });
}

export function useAcceptFreelancer() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; freelancer: string }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "acceptFreelancer",
        args: [BigInt(params.escrow_id), params.freelancer as `0x${string}`],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({ title: "Freelancer accepted", description: "The freelancer can now start work." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to accept freelancer", variant: "destructive" });
    },
  });
}

export function useSubmitEvidence() {
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; milestone_index: number; cid: string }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "submitEvidence",
        args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.cid],
      });
    },
    onSuccess: () => {
      toast({ title: "Evidence submitted", description: "Evidence has been recorded on-chain." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to submit evidence", variant: "destructive" });
    },
  });
}

export function useExtendDeadline() {
  const queryClient = useQueryClient();
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; extra_days: number }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "extendDeadline",
        args: [BigInt(params.escrow_id), BigInt(params.extra_days)],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escrow"] });
      queryClient.invalidateQueries({ queryKey: ["user-escrows"] });
      toast({ title: "Deadline extended", description: "The project deadline has been extended." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to extend deadline", variant: "destructive" });
    },
  });
}

export function useSubmitRating() {
  const { address } = useWalletStore();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (params: { escrow_id: number; score: number; review: string }) => {
      if (!address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "submitRating",
        args: [BigInt(params.escrow_id), params.score, params.review],
      });
    },
    onSuccess: () => {
      toast({ title: "Rating submitted", description: "Your feedback has been recorded on-chain." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to submit rating", variant: "destructive" });
    },
  });
}

// Alias for backwards compatibility
export const useRefundEscrow = useEmergencyRefund;
