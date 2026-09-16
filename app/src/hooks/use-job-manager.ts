/**
 * Reading and changing who manages a job.
 *
 * The on-chain `jobManager` is the authority here, not the agent daemon's task
 * table. The daemon knows what it BELIEVES it manages; the contract knows what
 * it will actually let the agent do. When they disagree — a client revoked
 * management and the daemon has not polled since — the contract is right.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { useWeb3 } from "@/contexts/web3-context";
import { contractService } from "@/lib/web3/contract-service";
import { humanizeError } from "@/lib/atelier/errors";
import {
  AUTOPILOT_CONFIGURED,
  fetchAutopilotAddress,
} from "@/lib/atelier/agent-api";

export interface JobManagerState {
  /** The managing agent's address, or null when the client runs the job. */
  manager: string | null;
  /** True once we know — `manager === null` is a real answer, not "loading". */
  loaded: boolean;
  busy: boolean;
  error: string | null;
  /** Hand this job to Autopilot. Resolves to the transaction hash. */
  delegate: () => Promise<string>;
  /** Take it back. Effective on the agent's very next call. */
  revoke: () => Promise<string>;
  refresh: () => Promise<void>;
}

/**
 * One answer per job, shared by everyone asking about it.
 *
 * WHY THIS EXISTS
 *
 * The card shows an Autopilot badge, the panel inside it offers to hand over or
 * take back, and the milestone buttons gate on the same fact — and each called
 * this hook separately, so each held its own copy. Taking a job back updated
 * the panel and left the badge above it still saying Autopilot, through a hard
 * refresh, because nothing told the other instances anything had changed.
 *
 * A tiny store rather than a data-fetching library: this is one address per
 * escrow, and every component that cares is on screen at the same time.
 */
const managerCache = new Map<number, string | null>();
const managerWatchers = new Map<number, Set<(v: string | null) => void>>();

/**
 * Told to everyone, including surfaces that do not use this hook.
 *
 * The job board reads which jobs Autopilot runs from the DAEMON's task table,
 * not the chain — one request for the whole board instead of one RPC call per
 * card. That is the right trade, and it means the board lags a hand-over by
 * the agent's next sweep: up to fifteen seconds in which the client has just
 * acted and nothing on the board has changed.
 *
 * So a delegation the client makes themselves is announced, and the board
 * applies it immediately and lets the next poll confirm it. Optimistic only
 * for the person who did it — everyone else waits for the daemon, which is the
 * honest source for what the agent is actually working on.
 */
export const JOB_MANAGER_EVENT = "atelier:job-manager";

/**
 * What this browser has learned first-hand about who manages which job.
 *
 * The job board reads the daemon's task table, which lags a hand-over by the
 * agent's next sweep. An event covers that gap only while both surfaces are
 * mounted — and My Jobs and Browse Jobs are different routes, so navigating
 * between them mounts a fresh board that asks the daemon and gets the old
 * answer. The client hands a job over, walks to the board, and the badge is
 * missing again.
 *
 * This cache is module-level, so it outlives the route change. It holds only
 * what this browser read from the chain itself, which is the one thing it can
 * be more current about than the daemon.
 */
/**
 * Record managers read somewhere other than this hook — a batched board read.
 *
 * Publishing them here means the board's multicall also answers the panel's
 * question, so opening a job you have just seen on the board renders the right
 * mode immediately instead of asking again and flickering.
 */
export function rememberJobManagers(entries: Record<number, string | null>): void {
  for (const [id, value] of Object.entries(entries)) {
    publishManager(Number(id), value);
  }
}

export function knownJobManagers(): { managed: Set<string>; unmanaged: Set<string> } {
  const managed = new Set<string>();
  const unmanaged = new Set<string>();
  for (const [escrowId, value] of managerCache) {
    (value !== null ? managed : unmanaged).add(String(escrowId));
  }
  return { managed, unmanaged };
}

function publishManager(escrowId: number, value: string | null): void {
  managerCache.set(escrowId, value);
  for (const fn of managerWatchers.get(escrowId) ?? []) fn(value);
  try {
    window.dispatchEvent(
      new CustomEvent(JOB_MANAGER_EVENT, { detail: { escrowId, managed: value !== null } }),
    );
  } catch {
    /* no window (tests, SSR) — the watchers above already fired */
  }
}

function watchManager(escrowId: number, fn: (v: string | null) => void): () => void {
  const set = managerWatchers.get(escrowId) ?? new Set();
  set.add(fn);
  managerWatchers.set(escrowId, set);
  return () => set.delete(fn);
}

export function useJobManager(escrowId: number | null): JobManagerState {
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  /* Held in a ref so settle() can call the current refresh without the two
     depending on each other and rebuilding on every render. */
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  /**
   * Wait for the transaction to be mined before believing anything about it.
   *
   * writeContractAsync resolves when a transaction is SUBMITTED, so refreshing
   * straight afterwards read the chain as it was before the call landed. The
   * UI then reported the opposite of what had just happened -- "you are running
   * this job again" while the agent was still the manager on-chain, or the
   * reverse after delegating -- and the only way to find out which was true was
   * to reload.
   */
  const settle = useCallback(
    async (hash: `0x${string}`) => {
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        /*
         * A mined transaction is not a successful one.
         *
         * waitForTransactionReceipt resolves for a REVERTED transaction just as
         * happily as for one that worked, and nothing checked which. So a
         * revoke that the contract rejected came back through the success path
         * and told the client "you are running this job again" while the agent
         * was still its manager on-chain. On a control they reach for precisely
         * when they want the agent to stop, that is the worst possible lie.
         */
        if (receipt.status === "reverted") {
          throw new Error(
            "The transaction was rejected on-chain, so nothing changed. Nobody's money moved.",
          );
        }
      }
      await refreshRef.current();
      return hash;
    },
    [publicClient],
  );

  const [manager, setManager] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (escrowId === null) {
      setManager(null);
      setLoaded(true);
      return;
    }
    try {
      const current = await contractService.getJobManager(escrowId);
      publishManager(escrowId, current);
      setManager(current);
      setLoaded(true);
      setError(null);
    } catch (e) {
      /*
       * Keep the last answer and stay "not loaded" rather than reporting null.
       *
       * null means "the client runs this job", so turning a failed read into it
       * flips every surface to the wrong mode: the panel offers to hand over a
       * job already handed over, and the milestone buttons come back on a job
       * the agent is mid-review on. Saying nothing is the honest failure.
       */
      setError(humanizeError(e));
    }
  }, [escrowId]);

  refreshRef.current = refresh;

  useEffect(() => {
    /* Reset before refetching. Without this, switching from an Autopilot job to
       a manual one briefly renders the previous job's manager as this one's. */
    setLoaded(false);
    setManager(null);

    if (escrowId === null) {
      void refresh();
      return;
    }

    /* Seed from whatever another instance already learned, so a second reader
       is never blank while it waits for its own request. */
    if (managerCache.has(escrowId)) {
      setManager(managerCache.get(escrowId) ?? null);
      setLoaded(true);
    }

    const stop = watchManager(escrowId, (v) => {
      setManager(v);
      setLoaded(true);
    });
    void refresh();
    return stop;
  }, [refresh, escrowId]);

  const delegate = useCallback(async () => {
    if (escrowId === null) throw new Error("No job selected.");
    if (!AUTOPILOT_CONFIGURED) {
      throw new Error("Autopilot is not configured for this deployment.");
    }
    setBusy(true);
    setError(null);
    try {
      // Ask the daemon which key it currently signs with, rather than trusting
      // a build-time constant that could be a redeploy out of date.
      const { address } = await fetchAutopilotAddress();

      if (address.toLowerCase() === wallet.address?.toLowerCase()) {
        throw new Error(
          "Autopilot reports your own address as its wallet — refusing to delegate.",
        );
      }

      const hash = await contractService.setJobManager(
        { escrow_id: escrowId, manager: address },
        writeContractAsync,
      );
      return await settle(hash);
    } catch (e) {
      const message = humanizeError(e);
      setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [escrowId, wallet.address, writeContractAsync, settle]);

  const revoke = useCallback(async () => {
    if (escrowId === null) throw new Error("No job selected.");
    setBusy(true);
    setError(null);
    try {
      const hash = await contractService.revokeJobManager(
        escrowId,
        writeContractAsync,
      );
      return await settle(hash);
    } catch (e) {
      const message = humanizeError(e);
      setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [escrowId, writeContractAsync, settle]);

  return { manager, loaded, busy, error, delegate, revoke, refresh };
}
