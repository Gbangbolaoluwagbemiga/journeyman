// Reads from the Atelier subgraph, or from the chain when the subgraph can't answer.
import { config } from "../config.js";
import { applicationsFromChain, escrowFromChain } from "./chain-fallback.js";

export function isGraphConfigured(): boolean {
  return Boolean(config.graphUrl);
}

/**
 * True for reads the hire loop cannot proceed without.
 *
 * Matched on the query's operation name rather than the whole string so
 * whitespace or a field reordering does not quietly drop a query back onto the
 * throwing path — which is the failure this exists to prevent.
 */
function singleEscrowRead(query: string): "applications" | "escrow" | null {
  if (query.includes("query GetJobApplications")) return "applications";
  if (query.includes("query GetJobById")) return "escrow";
  return null;
}

/**
 * Answer one of the two hire-loop reads from chain logs, or return null if this
 * query isn't one of them.
 *
 * The subgraph remains the fast path and the right answer for lists, history
 * and anything spanning escrows. These two reads concern a single escrow, so
 * the chain can answer them directly and the product degrades in speed instead
 * of halting.
 */
async function fromChain<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  const kind = singleEscrowRead(query);
  const escrowId = variables?.escrowId;
  if (!kind || escrowId == null) return null;
  return (kind === "applications"
    ? await applicationsFromChain(String(escrowId))
    : await escrowFromChain(String(escrowId))) as T;
}

export async function graphQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  /*
   * Without this the daemon simply stopped.
   *
   * The poller's first step for a posted job is GetJobApplications, and this
   * function threw when GRAPH_URL was unset — so with no subgraph deployed
   * nothing was ever scored and nobody was ever hired. It read as the agent
   * being idle rather than as a missing dependency, which is the worst way for
   * a dependency to be missing.
   */
  if (!config.graphUrl) {
    const answered = await fromChain<T>(query, variables);
    if (answered !== null) return answered;
    throw new Error("GRAPH_URL is not set, and this query has no chain fallback");
  }

  try {
    const res = await fetch(config.graphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(json.errors[0]!.message);
    return json.data as T;
  } catch (err) {
    /*
     * A configured subgraph that will not answer is the same situation as no
     * subgraph at all, and until this existed only the second case was handled.
     *
     * Observed live: Graph Studio began returning HTTP 429 and the poller spent
     * 55 minutes retrying the same GetJobApplications every 15 seconds. One
     * freelancer had applied on chain, the review window had closed, and the
     * client's screen kept saying the agent hadn't read the applications yet —
     * because the read threw before scoring was ever reached. The applications
     * were sitting in chain logs the whole time.
     *
     * So the outage falls back to the chain rather than failing the task. Lists
     * and history still surface the error: they have no chain equivalent, and a
     * silent empty page there would be worse than a loud failure.
     */
    const answered = await fromChain<T>(query, variables);
    if (answered !== null) {
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`[graph] subgraph unavailable (${why}) — answering from the chain instead`);
      return answered;
    }
    throw err;
  }
}
