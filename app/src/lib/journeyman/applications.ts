import { graphQuery, isGraphConfigured } from "@/lib/graph/client";

/**
 * WHAT HAPPENED TO THE JOBS YOU APPLIED FOR.
 *
 * Applying was a one-way door. A freelancer wrote a cover letter, signed a
 * transaction, and then had nowhere to look: not a list of what they had
 * applied to, not whether the client had chosen anybody, not whether that
 * anybody was them. The only signal was a notification that might never
 * arrive — written from the client's browser, so it depended on the client
 * still having the tab open when the transaction confirmed.
 *
 * That is the wrong shape for something this consequential. A notification is
 * a nudge; the answer has to be somewhere you can go and look. Everything here
 * is derived from the chain's own record of the escrow, so it is correct even
 * if every notification we ever sent was lost.
 */

/** Escrow status codes, as the contract numbers them. */
const PENDING = 0;
const IN_PROGRESS = 1;
const CANCELLED = 6;

const ZERO = "0x0000000000000000000000000000000000000000";

export type ApplicationOutcome =
  /** Nobody hired yet. The client still has this to decide. */
  | "waiting"
  /** You were chosen. */
  | "won"
  /** Somebody else was chosen. */
  | "passed"
  /** The client withdrew the job before choosing anyone. */
  | "withdrawn";

export interface AppliedJob {
  escrowId: string;
  projectTitle: string;
  projectDescription: string;
  category: string | null;
  totalAmount: string;
  deadline: number;
  appliedAt: number;
  outcome: ApplicationOutcome;
}

interface RawApplication {
  escrowId: string;
  timestamp: string;
  escrow: {
    beneficiary: string;
    status: number;
    totalAmount: string;
    deadline: string;
    projectTitle: string;
    projectDescription: string;
    category: string | null;
  } | null;
}

export const GET_MY_APPLICATIONS = `
  query GetMyApplications($freelancer: Bytes!) {
    applications(
      where: { freelancer: $freelancer }
      orderBy: timestamp
      orderDirection: desc
      first: 200
    ) {
      escrowId
      timestamp
      escrow {
        beneficiary
        status
        totalAmount
        deadline
        projectTitle
        projectDescription
        category
      }
    }
  }
`;

/**
 * What became of one application.
 *
 * Read off the escrow rather than off any record of our own, because the escrow
 * is the only account of a hire that cannot be stale — it IS the hire. A
 * beneficiary that is set and is not you means the job is gone, whether or not
 * anyone remembered to tell you.
 */
export function outcomeOf(
  escrow: { beneficiary?: string | null; status?: number | null } | null | undefined,
  me: string,
): ApplicationOutcome {
  if (!escrow) return "waiting";

  const hired = (escrow.beneficiary ?? "").toLowerCase();
  const mine = me.toLowerCase();

  if (hired && hired !== ZERO) {
    return hired === mine ? "won" : "passed";
  }

  /*
   * Cancelled with nobody hired: the client took the money back. Distinct from
   * "passed" on purpose — being turned down and the job evaporating are
   * different pieces of news, and lumping them together would have a freelancer
   * believe they lost a competition that never concluded.
   */
  if (escrow.status === CANCELLED) return "withdrawn";

  /*
   * A job in progress with no beneficiary should not exist, but the subgraph
   * has trailed the chain before. "Waiting" is the safer wrong answer: it tells
   * someone to check back, where "passed" tells them to stop hoping.
   */
  if (escrow.status === PENDING || escrow.status === IN_PROGRESS) return "waiting";

  return "waiting";
}

/** Only the ones the client has yet to decide. */
export function pendingOnly(jobs: AppliedJob[]): AppliedJob[] {
  return jobs.filter((j) => j.outcome === "waiting");
}

export async function fetchMyApplications(address: string): Promise<AppliedJob[]> {
  if (!isGraphConfigured() || !address) return [];

  const data = await graphQuery<{ applications: RawApplication[] }>(GET_MY_APPLICATIONS, {
    freelancer: address.toLowerCase(),
  });

  return (data.applications ?? []).map((a) => ({
    escrowId: a.escrowId,
    projectTitle: a.escrow?.projectTitle ?? "",
    projectDescription: a.escrow?.projectDescription ?? "",
    category: a.escrow?.category ?? null,
    totalAmount: a.escrow?.totalAmount ?? "0",
    deadline: Number(a.escrow?.deadline ?? 0),
    appliedAt: Number(a.timestamp ?? 0),
    outcome: outcomeOf(a.escrow, address),
  }));
}
