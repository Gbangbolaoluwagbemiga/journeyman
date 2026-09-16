// ── Shared fragment ──────────────────────────────────────────────────────────

const MILESTONE_FIELDS = `
  milestoneIndex
  amount
  description
  status
  submittedAt
  approvedAt
  proposedAmount
  proposedDescription
`;

/*
 * NOT SELECTED YET: `jobManager`.
 *
 * The redeployed subgraph indexes the Autopilot manager on every escrow (see
 * subgraph/schema.graphql), and selecting it here would save an RPC round trip
 * per job when rendering a list.
 *
 * It is deliberately absent until that subgraph is live, because GraphQL errors
 * on an unknown field rather than ignoring it — adding it now would break EVERY
 * escrow query against the Goldsky endpoint currently in production, not just
 * the manager lookup. Add the line in the same change that switches
 * VITE_GRAPH_URL to the Studio endpoint, not before.
 *
 * Until then `contractService.getJobManager` reads it from the contract, which
 * is authoritative anyway — the subgraph is the optimisation, not the source of
 * truth.
 */
const ESCROW_CORE = `
  id
  escrowId
  depositor
  beneficiary
  token
  totalAmount
  paidAmount
  platformFee
  deadline
  status
  workStarted
  isOpenJob
  projectTitle
  projectDescription
  createdAt
  milestones(orderBy: milestoneIndex, orderDirection: asc) {
    ${MILESTONE_FIELDS}
  }
`;

// ── Queries ───────────────────────────────────────────────────────────────────

/** All escrows where address is depositor or beneficiary */
export const GET_USER_ESCROWS = `
  query GetUserEscrows($address: Bytes!) {
    deposited: escrows(
      where: { depositor: $address }
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) { ${ESCROW_CORE} }
    assigned: escrows(
      where: { beneficiary: $address }
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) { ${ESCROW_CORE} }
  }
`;

/** All escrows — isOpenJob flag is unreliable in the subgraph for some jobs
 *  (beneficiary may be zero without isOpenJob=true). We fetch all and filter
 *  in JS after RPC enrichment, which is the authoritative source. */
export const GET_OPEN_JOBS = `
  query GetOpenJobs {
    escrows(
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) {
      ${ESCROW_CORE}
      applications { freelancer }
    }
  }
`;

/** Single escrow by on-chain ID */
export const GET_ESCROW = `
  query GetEscrow($id: ID!) {
    escrow(id: $id) {
      ${ESCROW_CORE}
      applications { freelancer coverLetter proposedTimeline }
    }
  }
`;

// ── Response types ────────────────────────────────────────────────────────────

export interface GQLMilestone {
  milestoneIndex: string;
  amount: string;
  description: string;
  status: number;
  submittedAt: string | null;
  approvedAt: string | null;
  proposedAmount: string | null;
  proposedDescription: string | null;
}

export interface GQLEscrow {
  id: string;
  escrowId: string;
  depositor: string;
  beneficiary: string;
  token: string;
  totalAmount: string;
  paidAmount: string;
  platformFee: string;
  deadline: string;
  status: number;
  workStarted: boolean;
  isOpenJob: boolean;
  projectTitle: string;
  projectDescription: string;
  createdAt: string;
  milestones: GQLMilestone[];
  applications?: { freelancer: string; coverLetter?: string; proposedTimeline?: string }[];
}

export interface UserEscrowsResponse {
  deposited: GQLEscrow[];
  assigned: GQLEscrow[];
}

export interface OpenJobsResponse {
  escrows: GQLEscrow[];
}

export interface SingleEscrowResponse {
  escrow: GQLEscrow | null;
}
