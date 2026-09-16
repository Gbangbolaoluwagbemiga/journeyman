/**
 * One job's decision log, polled.
 *
 * Polling rather than the daemon's SSE stream, deliberately: this mounts inside
 * an escrow card that a client opens and closes repeatedly while scanning their
 * jobs, and opening an EventSource per card would leave a trail of live
 * connections against a daemon whose whole job is to stay up. A client watching
 * an agent work is happy with a few seconds' latency; the daemon staying
 * reachable matters more.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTOPILOT_CONFIGURED,
  fetchDecisionsForEscrow,
} from "@/lib/atelier/agent-api";
import type { Decision } from "@/lib/atelier/actor";

const POLL_MS = 8000;

export interface DecisionsState {
  decisions: Decision[];
  loading: boolean;
  /** Set when the daemon is unreachable — rendered as a note, never a crash. */
  error: string | null;
  refresh: () => void;
}

export function useDecisions(
  escrowId: number | string | null,
  { enabled = true }: { enabled?: boolean } = {},
): DecisionsState {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Held in a ref so the poll effect does not restart on every fetch. */
  const tick = useRef(0);
  const [, force] = useState(0);
  const refresh = useCallback(() => {
    tick.current += 1;
    force((n) => n + 1);
  }, []);

  const active = enabled && escrowId !== null && AUTOPILOT_CONFIGURED;

  useEffect(() => {
    if (!active) {
      setDecisions([]);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      try {
        const next = await fetchDecisionsForEscrow(
          escrowId as number,
          controller.signal,
        );
        if (!cancelled) {
          setDecisions(next);
          setError(null);
        }
      } catch (e) {
        // An aborted fetch is this component unmounting, not a failure.
        if (cancelled || controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    void load();
    const id = setInterval(() => void load(), POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [active, escrowId, tick.current]);

  return { decisions, loading, error, refresh };
}
