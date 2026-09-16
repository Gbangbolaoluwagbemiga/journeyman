import { useEffect, useRef } from "react";
import { useWeb3 } from "@/contexts/web3-context";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

const POLL_INTERVAL_MS = 45_000;

/**
 * Invisible background component that acts as a lightweight indexer.
 *
 * Every 45 seconds (and only when the tab is visible) it fetches the current
 * user's
 * escrow IDs from the contract.  If the set of IDs has changed since the last
 * check it dispatches `escrowUpdated` — the same event that DashboardPage and
 * FreelancerPage already listen to for silent background re-fetches.
 *
 * For within-escrow changes we rely on notification-driven event dispatch.
 * This poller is now only a slow safety net.
 *
 * Mount once inside AppLayout.
 */
export function EscrowPoller() {
  const { wallet } = useWeb3();
  // Stores the stringified sorted list of escrow IDs seen last poll
  const prevIdsRef = useRef<string | null>(null);

  useEffect(() => {
    if (!wallet.address) return;

    const dispatch = () =>
      window.dispatchEvent(new CustomEvent("escrowUpdated"));

    const poll = async () => {
      // Skip if tab is hidden to avoid waking up the network needlessly
      if (document.visibilityState === "hidden") return;

      try {
        const contractService = new ContractService(
          CONTRACTS.ATELIER_ESCROW
        );
        const ids: number[] = await contractService.getUserEscrows(
          wallet.address!
        );
        if (!Array.isArray(ids)) return;

        const idsKey = [...ids].sort((a, b) => a - b).join(",");

        if (prevIdsRef.current === null) {
          // First poll – establish baseline, no dispatch
          prevIdsRef.current = idsKey;
          return;
        }

        if (idsKey !== prevIdsRef.current) {
          // New escrow appeared (or one disappeared) – refresh
          prevIdsRef.current = idsKey;
          dispatch();
          return;
        }

      } catch {
        // Silent safety poll; ignore transient RPC failures.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    };

    // Run once immediately so the first refresh happens quickly
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [wallet.address]);

  return null;
}
