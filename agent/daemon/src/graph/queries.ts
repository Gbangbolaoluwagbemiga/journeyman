// Atelier-specific subgraph queries
// All jobs Atelier posted are identified by depositor === Atelier's Agent Wallet address

export const GET_AGENT_JOBS = `
  query GetAgentJobs($agentAddress: Bytes!) {
    escrows(
      where: { depositor: $agentAddress }
      orderBy: createdAt
      orderDirection: desc
      first: 50
    ) {
      id
      escrowId
      depositor
      beneficiary
      token
      totalAmount
      paidAmount
      deadline
      status
      isOpenJob
      projectTitle
      projectDescription
      createdAt
      milestones(orderBy: milestoneIndex, orderDirection: asc) {
        milestoneIndex
        amount
        description
        status
        submittedAt
        approvedAt
      }
      applications {
        freelancer
        coverLetter
        proposedTimeline
        timestamp
      }
    }
  }
`;

export const GET_JOB_APPLICATIONS = `
  query GetJobApplications($escrowId: String!) {
    escrow(id: $escrowId) {
      escrowId
      status
      applications {
        freelancer
        coverLetter
        proposedTimeline
        timestamp
      }
    }
  }
`;

export const GET_JOB_BY_ID = `
  query GetJobById($escrowId: String!) {
    escrow(id: $escrowId) {
      id
      escrowId
      depositor
      beneficiary
      token
      totalAmount
      paidAmount
      deadline
      status
      projectTitle
      projectDescription
      createdAt
      milestones(orderBy: milestoneIndex, orderDirection: asc) {
        milestoneIndex
        amount
        description
        status
        submittedAt
        approvedAt
      }
      applications {
        freelancer
        coverLetter
        proposedTimeline
        timestamp
      }
    }
  }
`;

export interface GQLApplication {
  freelancer: string;
  coverLetter: string;
  proposedTimeline: string;
  timestamp: string;
}

export interface GQLMilestone {
  milestoneIndex: string;
  amount: string;
  description: string;
  status: number;
  submittedAt: string | null;
  approvedAt: string | null;
}

export interface GQLEscrow {
  id: string;
  escrowId: string;
  depositor: string;
  beneficiary: string;
  token: string;
  totalAmount: string;
  paidAmount: string;
  deadline: string;
  status: number;
  isOpenJob: boolean;
  projectTitle: string;
  projectDescription: string;
  createdAt: string;
  milestones: GQLMilestone[];
  applications: GQLApplication[];
}

/**
 * Every job this person was hired for.
 *
 * WHY THIS EXISTS
 *
 * "What work is mine" was answered by walking FreelancerAccepted logs from the
 * contract's deploy block in windowed getLogs calls — seventy-six sequential
 * round trips, growing by one every nine thousand blocks. A freelancer's board
 * took twenty seconds to load and was getting slower every day the chain
 * advanced. That is exactly the read an index exists for.
 *
 * Keyed on beneficiary rather than the acceptance event, so it answers the
 * question directly: the escrow names who is on it now. The chain walk stays as
 * the fallback for when the subgraph cannot answer.
 */
export const GET_JOBS_FOR_FREELANCER = `
  query GetJobsForFreelancer($who: Bytes!) {
    escrows(
      where: { beneficiary: $who }
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) {
      escrowId
      status
      totalAmount
      projectTitle
      milestones(orderBy: milestoneIndex, orderDirection: asc) {
        milestoneIndex
        amount
        description
        status
      }
    }
  }
`;
