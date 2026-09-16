import { useState, useEffect } from "react";
import { useWeb3 } from "@/contexts/web3-context";
import { contractService } from "@/lib/web3/contract-service";

export function usePendingApprovals() {
  const { wallet } = useWeb3();
  const [hasPendingApprovals, setHasPendingApprovals] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wallet.isConnected || !wallet.address) {
      setHasPendingApprovals(false);
      return;
    }

    checkPendingApprovals();
  }, [wallet.isConnected, wallet.address]);

  const checkPendingApprovals = async () => {
    setLoading(true);
    try {
      if (!wallet.address) {
        setHasPendingApprovals(false);
        return;
      }

      // Use the contract’s user escrows index (fast + accurate)
      const escrowIds = await contractService.getUserEscrows(wallet.address);

      for (const id of escrowIds) {
        const escrow = await contractService.getEscrow(id);
        if (!escrow) continue;

        const isMyJob =
          escrow.depositor?.toLowerCase().trim() === wallet.address.toLowerCase().trim();
        if (!isMyJob) continue;

        /*
         * Only a job that is still Pending has anything to approve.
         *
         * This checked whether the job was open and had applicants, and never
         * once looked at its status — so a cancelled job that had received a
         * single application went on claiming a decision was waiting, forever.
         * The dot sat on My Jobs with nothing behind it, which is worse than no
         * dot at all: a notification that is sometimes wrong stops being read.
         */
        const PENDING = 0;
        if (Number(escrow.status) !== PENDING) continue;

        const zeroAddress = "0x0000000000000000000000000000000000000000";
        const isOpenJob =
          escrow.isOpenJob ||
          !escrow.beneficiary ||
          escrow.beneficiary === zeroAddress;
        if (!isOpenJob) continue;

        const applications = await contractService.getApplications(id);
        if (applications && applications.length > 0) {
          setHasPendingApprovals(true);
          return;
        }
      }

      setHasPendingApprovals(false);
    } catch (error) {
      setHasPendingApprovals(false);
    } finally {
      setLoading(false);
    }
  };

  return {
    hasPendingApprovals,
    loading,
    refreshApprovals: checkPendingApprovals,
  };
}
