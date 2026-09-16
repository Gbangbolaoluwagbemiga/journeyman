/**
 * WHO IS USING THE APP RIGHT NOW.
 *
 * Atelier has two ways to be somebody: a wallet you connected, and a managed
 * Circle wallet you signed into with Google. Most of the app was written when
 * only the first existed, so surfaces kept reaching for `wallet.address` — and
 * a managed worker, who never connects one, read as nobody.
 *
 * That is not a cosmetic gap. Messages was the clearest case: a client sent a
 * direct message to a freelancer on a managed wallet, and that freelancer's
 * inbox asked for the conversations of the empty string. The message was in the
 * table, addressed to them, and there was no screen in the product that could
 * show it to them.
 *
 * The rule — a connected wallet wins, a managed session is the fallback — was
 * already written down inside the notification context. It is here now so there
 * is one answer to "who am I" rather than one per feature.
 */

import { useEffect, useState } from "react";
import { useWeb3 } from "@/contexts/web3-context";
import { currentWorkerAddress, WORKER_IDENTITY_EVENT } from "@/lib/atelier/worker";

export function useMyAddress(): string | null {
  const { wallet } = useWeb3();

  const [workerAddress, setWorkerAddress] = useState<string | null>(() =>
    currentWorkerAddress(),
  );

  useEffect(() => {
    const sync = () => setWorkerAddress(currentWorkerAddress());
    /* `storage` too, so signing out in one tab empties the other. */
    window.addEventListener(WORKER_IDENTITY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WORKER_IDENTITY_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  /* A connected wallet wins: that is somebody actively using the app as a
     client, and they may well also have a managed session lying around from
     testing the other side of the marketplace. */
  return wallet.address ?? workerAddress ?? null;
}

/**
 * Whether two addresses are the same person.
 *
 * An address has two valid spellings — the checksummed mixed case a wallet
 * hands you, and lowercase — and `===` says those are different people. That
 * is how a direct message ends up on the wrong side of a chat thread, and how
 * an inbox ends up empty.
 */
export function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
