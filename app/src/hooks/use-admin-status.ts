import { useState, useEffect } from "react";
import { useWeb3 } from "@/contexts/web3-context";
import { useDelegation } from "@/contexts/delegation-context";
import { CONTRACTS } from "@/lib/web3/config";
import { contractService } from "@/lib/web3/contract-service";

export function useAdminStatus() {
  const { wallet } = useWeb3();
  const { getActiveDelegations, delegations } = useDelegation();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [isArbiter, setIsArbiter] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wallet.isConnected || !wallet.address) {
      setIsAdmin(false);
      setIsOwner(false);
      setIsArbiter(false);
      return;
    }

    checkAdminStatus();
  }, [wallet.isConnected, wallet.address, delegations.length]);

  const checkAdminStatus = async () => {
    setLoading(true);
    try {
      // Check if contract address is set
      if (!CONTRACTS.ATELIER_ESCROW) {
        setIsAdmin(false);
        setIsOwner(false);
        setIsArbiter(false);
        return;
      }

      // Get the contract owner from on-chain state
      let owner: string | null = null;
      try {
        owner = await contractService.getOwner();
      } catch (e) {
        // Fallback: allow a manual override while debugging deployments
        owner = (import.meta.env.VITE_OWNER_ADDRESS || "").trim() || null;
      }

      if (!owner) {
        setIsAdmin(false);
        setIsOwner(false);
        setIsArbiter(false);
        return;
      }

      // Normalize both addresses to strings and lowercase for comparison
      const ownerStr = String(owner).toLowerCase().trim();
      const walletStr = (wallet.address || "").toLowerCase().trim();


      // Check if current wallet is the owner
      const ownerCheck = ownerStr === walletStr;
      setIsOwner(ownerCheck);

      // Check if user is an authorized arbiter
      let arbiterCheck = false;
      if (wallet.address) {
        try {
          arbiterCheck = await contractService.isAuthorizedArbiter(
            wallet.address
          );
        } catch (error) {
        }
      }
      setIsArbiter(arbiterCheck);

      // Also check if user has an active delegation granted TO their address
      const activeDelegations = getActiveDelegations();
      const hasDelegationForUser = activeDelegations.some(
        (d) => d.delegatee.toLowerCase() === wallet.address?.toLowerCase()
      );

      // User is admin if they are owner, arbiter, or have delegation
      setIsAdmin(ownerCheck || arbiterCheck || hasDelegationForUser);
    } catch (error) {
      setIsAdmin(false);
      setIsOwner(false);
      setIsArbiter(false);
    } finally {
      setLoading(false);
    }
  };

  return { isAdmin, isOwner, isArbiter, loading };
}
