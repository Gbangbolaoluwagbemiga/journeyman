import { useState, useEffect, useCallback } from "react";
import { useWeb3 } from "@/contexts/web3-context";
import { CONTRACTS } from "@/lib/web3/config";
import { ContractService } from "@/lib/web3/contract-service";

export function useJobCreatorStatus() {
  const { wallet } = useWeb3();
  const [isJobCreator, setIsJobCreator] = useState(false);
  const [loading, setLoading] = useState(true); // Start with true to show loading initially

  const checkJobCreatorStatus = useCallback(async () => {
    if (!wallet.isConnected || !wallet.address) {
      setIsJobCreator(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      // Check up to 20 escrows (reasonable limit)
      const maxEscrowsToCheck = 20;
      for (let i = 1; i <= maxEscrowsToCheck; i++) {
        try {
          const escrow = await contractService.getEscrow(i);

          // Skip if escrow doesn't exist
          if (!escrow) {
            // If we've checked a few escrows and none exist, stop checking
            if (i > 5) {
              break;
            }
            continue;
          }


          // Extract creator address from escrow
          // EscrowData has a 'creator' field
          const depositorAddress = escrow.depositor;

          // Check if current user is the creator (job creator)
          const isMyJob =
            wallet.address &&
            depositorAddress &&
            depositorAddress.toLowerCase().trim() ===
              wallet.address.toLowerCase().trim();

          if (isMyJob) {
            setIsJobCreator(true);
            setLoading(false);
            return;
          }
        } catch (error) {
          // If we get an error, it might mean the escrow doesn't exist
          // Stop checking after a few consecutive errors
          if (i > 5) {
            break;
          }
          continue;
        }
      }

      setIsJobCreator(false);
    } catch (error) {
      setIsJobCreator(false);
    } finally {
      setLoading(false);
    }
  }, [wallet.isConnected, wallet.address]);

  useEffect(() => {
    checkJobCreatorStatus();
  }, [checkJobCreatorStatus]);

  return { isJobCreator, loading };
}
