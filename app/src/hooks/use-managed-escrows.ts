/**
 * Which jobs Autopilot is running.
 *
 * Read from the agent's own task table rather than from the chain, and that is
 * a deliberate trade. The on-chain `jobManager` is authoritative about what the
 * agent is PERMITTED to do; the task table is authoritative about what it is
 * actually doing. For a badge on a job card the second is the useful one — and
 * reading it costs one request instead of one RPC call per job on the board.
 *
 * Fails soft to an empty set. The daemon being unreachable should mean no
 * badges, not a broken marketplace: a missing badge under-claims, and
 * under-claiming is the safe direction for a label a freelancer relies on.
 *
 * WHY IT POLLS
 *
 * It used to read once on mount and never again, with no way to ask it to look
 * again. So handing a job to Autopilot changed nothing on the board: the job
 * list refetched happily, the badge stayed missing, and the only thing that
 * brought it back was a full page reload — which remounted the hook. The
 * Refresh button spun and could not have helped.
 *
 * Two things have to move before the badge is right, and only one of them is
 * ours. Delegation is on-chain immediately; the daemon only learns about it on
 * its next sweep, which runs every fifteen seconds. So this polls rather than
 * fetching once, and the interval is set below that sweep — the answer cannot
 * arrive before the agent has it, and there is no point asking faster than it
 * can change.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AUTOPILOT_CONFIGURED,
  fetchManagedEscrowIds,
} from "@/lib/atelier/agent-api";
import {
  JOB_MANAGER_EVENT,
  knownJobManagers,
  rememberJobManagers,
} from "@/hooks/use-job-manager";
import { contractService } from "@/lib/web3/contract-service";

/** Below the daemon's own 15s adoption sweep — see the note above. */
const POLL_MS = 10_000;

export function useManagedEscrows(visibleEscrowIds: number[] = []): {
  managed: Set<string>;
  loaded: boolean;
  /** Ask again now. Wired to the board's Refresh, which otherwise did nothing. */
  refresh: () => void;
} {
  const [managed, setManaged] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  /*
   * The client's own hand-over, applied at once.
   *
   * This polls the daemon, which only learns about a delegation on its next
   * sweep — so for up to fifteen seconds after somebody hands a job over, the
   * board they are looking at still shows it unmanaged, and pressing Refresh
   * cannot help. Their own action is one thing we know before the daemon does.
   *
   * Optimistic for them alone; the next poll reconciles, and if the delegation
   * did not actually land the badge goes away again on its own.
   */
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ escrowId: number; managed: boolean }>).detail;
      if (!d) return;
      setManaged((prev) => {
        const next = new Set(prev);
        if (d.managed) next.add(String(d.escrowId));
        else next.delete(String(d.escrowId));
        return next;
      });
    };
    window.addEventListener(JOB_MANAGER_EVENT, onChange);
    return () => window.removeEventListener(JOB_MANAGER_EVENT, onChange);
  }, []);

  /* Joined rather than passed as an array: a fresh array literal on every
     render would restart the effect on every render. */
  const visibleKey = visibleEscrowIds.join(",");

  useEffect(() => {
    if (!AUTOPILOT_CONFIGURED) {
      setLoaded(true);
      return;
    }
    const visibleIds = visibleKey ? visibleKey.split(",").map(Number) : [];
    const controller = new AbortController();
    let cancelled = false;

    /*
     * THE CHAIN FIRST, IN ONE REQUEST.
     *
     * multicall3 answers "who manages each of these" for every job on the page
     * in a single round trip, which removes the reason this read the daemon at
     * all. The badge is now as current as the chain rather than as current as
     * the agent's housekeeping sweep — up to forty seconds of lag, gone.
     *
     * The daemon stays as the fallback, because it is the one source that
     * survives an RPC refusing to answer, and a late badge beats no badge.
     */
    const readChain = async (): Promise<Set<string> | null> => {
      /* Nothing on screen to ask about is not an answer — a caller that does
         not pass a list still wants the daemon's view, not an empty board. */
      if (visibleIds.length === 0) return null;
      try {
        const managers = await contractService.getJobManagersBatch(visibleIds);
        /* Share it: the panel inside a card asks the same question. */
        rememberJobManagers(managers);
        return new Set(
          Object.entries(managers)
            .filter(([, v]) => v !== null)
            .map(([id]) => id),
        );
      } catch {
        return null;
      }
    };

    const read = async () => {
      const fromChain = await readChain();
      if (fromChain && !cancelled) {
        setManaged(fromChain);
        setLoaded(true);
        return;
      }
      return fetchManagedEscrowIds(controller.signal)
        .then((ids) => {
          if (cancelled) return;
          /*
           * Merged with what this browser read from the chain directly.
           *
           * The daemon is the right source for what the agent is ACTUALLY
           * working on, and it lags a hand-over by a sweep. A client who just
           * delegated then navigated here would see no badge — their own action
           * undone by a slower source. Anything read from the chain in this
           * session wins over the daemon's older view, in both directions: a
           * fresh delegation shows at once, and a fresh revocation disappears
           * at once.
           */
          const { managed: knownOn, unmanaged: knownOff } = knownJobManagers();
          const merged = new Set(ids);
          for (const id of knownOn) merged.add(id);
          for (const id of knownOff) merged.delete(id);
          setManaged(merged);
        })
        .catch(() => {
          /* Unreachable agent means no badges, not a broken board. */
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };

    void read();
    const timer = setInterval(() => void read(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [tick, visibleKey]);

  return { managed, loaded, refresh };
}
