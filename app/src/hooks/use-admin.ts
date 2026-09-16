import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWriteContract } from "wagmi";
import { CONTRACTS } from "@/lib/web3/config";
import AtelierABI from "@/lib/web3/AtelierABI.json";
import { toast } from "@/hooks/use-toast";
import { useWeb3 } from "@/contexts/web3-context";

function contractAddr() {
  const addr = CONTRACTS.ATELIER_ESCROW;
  if (!addr) throw new Error("VITE_ATELIER_CONTRACT_ADDRESS is not set");
  return addr as `0x${string}`;
}

export function usePauseJobCreation() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async () => {
      if (!wallet.address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "pause",
        args: [],
      });
    },
    onSuccess: (txHash) => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Contract paused", description: `Tx: ${String(txHash).slice(0, 10)}…` });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to pause", variant: "destructive" });
    },
  });
}

export function useUnpauseJobCreation() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async () => {
      if (!wallet.address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "unpause",
        args: [],
      });
    },
    onSuccess: (txHash) => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Contract unpaused", description: `Tx: ${String(txHash).slice(0, 10)}…` });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to unpause", variant: "destructive" });
    },
  });
}

export function useSetPlatformFee() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (feeBP: number) => {
      if (!wallet.address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "setPlatformFee",
        args: [BigInt(feeBP)],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Platform fee updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to set fee", variant: "destructive" });
    },
  });
}

export function useSetFeeCollector() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (feeCollector: string) => {
      if (!wallet.address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "setFeeCollector",
        args: [feeCollector as `0x${string}`],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Fee collector updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to set fee collector", variant: "destructive" });
    },
  });
}

export function useWhitelistToken() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (token: string) => {
      if (!wallet.address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "whitelistToken",
        args: [token as `0x${string}`],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Token whitelisted" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to whitelist token", variant: "destructive" });
    },
  });
}

export function useAuthorizeArbiter() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (arbiter: string) => {
      if (!wallet.address) throw new Error("Wallet not connected");
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "authorizeArbiter",
        args: [arbiter as `0x${string}`],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Arbiter authorized" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to authorize arbiter", variant: "destructive" });
    },
  });
}

export function useWithdrawFees() {
  const queryClient = useQueryClient();
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();

  return useMutation({
    mutationFn: async (token: string) => {
      if (!wallet.address) throw new Error("Wallet not connected");
      const zeroAddress = "0x0000000000000000000000000000000000000000";
      return writeContractAsync({
        address: contractAddr(),
        abi: AtelierABI.abi,
        functionName: "withdrawFees",
        args: [(token || zeroAddress) as `0x${string}`],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast({ title: "Fees withdrawn", description: "Platform fees sent to fee collector." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to withdraw fees", variant: "destructive" });
    },
  });
}
