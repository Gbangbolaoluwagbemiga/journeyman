import { useState, useEffect, useCallback } from "react";
import { useWeb3 } from "@/contexts/web3-context";
import { CONTRACTS } from "@/lib/web3/config";

export function useFreelancerStatus() {
  const { wallet } = useWeb3();
  const [isFreelancer, setIsFreelancer] = useState(false);
  const [loading, setLoading] = useState(false);

  const checkFreelancerStatus = useCallback(async () => {
    if (!wallet.isConnected || !wallet.address) {
      setIsFreelancer(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Use ContractService instead of contract.call - it reads from blockchain
      const { ContractService } = await import("@/lib/web3/contract-service");
      const contractService = new ContractService(CONTRACTS.ATELIER_ESCROW);

      // Get next escrow ID from blockchain (not hardcoded)
      const nextEscrowId = await contractService.getNextEscrowId();

      // Check if current wallet is beneficiary of any escrow
      const maxEscrowsToCheck = Math.min(nextEscrowId - 1, 20);
      for (let i = 1; i <= maxEscrowsToCheck; i++) {
        try {
          const escrow = await contractService.getEscrow(i);

          if (!escrow) {
            if (i > 5) {
              // Stop checking after a few non-existent escrows
              break;
            }
            continue;
          }


          // Check if current user is the beneficiary (freelancer)
          const isBeneficiary =
            escrow.beneficiary &&
            escrow.beneficiary.toLowerCase().trim() ===
              wallet.address.toLowerCase().trim();


          if (isBeneficiary) {
            setIsFreelancer(true);
            setLoading(false);
            return;
          }
        } catch (error) {
          if (i > 5) {
            break;
          }
          continue;
        }
      }

      setIsFreelancer(false);
    } catch (error) {
      setIsFreelancer(false);
    } finally {
      setLoading(false);
    }
  }, [wallet.isConnected, wallet.address]);

  useEffect(() => {
    checkFreelancerStatus();
  }, [checkFreelancerStatus]);

  return { isFreelancer, loading };
}
