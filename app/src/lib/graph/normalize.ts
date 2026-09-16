import type { GQLEscrow, GQLMilestone } from "./queries";
import type { Escrow, Milestone } from "@/lib/web3/types";
import { getOriginalDescription, cacheOriginalDescription } from "@/lib/milestone-cache";

/** Subgraph status int → app status string */
function escrowStatus(n: number): Escrow["status"] {
  switch (n) {
    case 0: return "pending";
    case 1: return "active";
    case 2: return "completed";
    case 3: return "refunded";
    case 4: return "disputed";
    case 5: return "expired";
    case 6: return "cancelled";
    default: return "pending";
  }
}

/** Contract (RPC) milestone status int → app milestone status string (exported for enrichment) */
export function rpcMilestoneStatus(n: number): Milestone["status"] {
  switch (n) {
    case 0: return "pending";
    case 1: return "submitted";
    case 2: return "approved";
    case 3: return "rejected";
    case 4: return "disputed";
    case 5: return "proposal_pending";
    default: return "pending";
  }
}

/** Subgraph milestone status int → app milestone status string */
function milestoneStatus(n: number): Milestone["status"] {
  switch (n) {
    case 0: return "pending";
    case 1: return "submitted";
    case 2: return "approved";
    case 3: return "rejected";
    case 4: return "disputed";
    case 5: return "proposal_pending";
    default: return "pending";
  }
}

function normalizeMilestone(m: GQLMilestone, escrowId: string, idx: number): Milestone {
  const status = milestoneStatus(Number(m.status));
  const description = m.description ?? "";

  // Snapshot pending milestone descriptions to cache (these are the originals)
  if (status === "pending" && description) {
    cacheOriginalDescription(escrowId, idx, description);
  }
  const originalDescription = getOriginalDescription(escrowId, idx);

  return {
    description,
    originalDescription,
    amount: m.amount ?? "0",
    status,
    submittedAt: m.submittedAt ? Number(m.submittedAt) * 1000 : undefined,
    approvedAt: m.approvedAt ? Number(m.approvedAt) * 1000 : undefined,
    proposedAmount: m.proposedAmount ?? undefined,
    proposedDescription: m.proposedDescription ?? undefined,
  };
}

export function normalizeEscrow(
  g: GQLEscrow,
  walletAddress: string,
): Escrow {
  const addr = walletAddress.toLowerCase();
  const isPayer = g.depositor?.toLowerCase() === addr;
  const isBeneficiary = g.beneficiary?.toLowerCase() === addr;
  const escrowId = g.escrowId ?? g.id;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const deadlineSeconds = Number(g.deadline ?? 0);

  const milestones = (g.milestones ?? []).map((m, idx) =>
    normalizeMilestone(m, escrowId, idx),
  );

  return {
    id: escrowId,
    payer: g.depositor ?? "",
    beneficiary: g.beneficiary ?? "",
    isClient: isPayer || undefined,
    isJobCreator: isPayer || undefined,
    isFreelancer: isBeneficiary || undefined,
    token: g.token ?? "",
    totalAmount: g.totalAmount ?? "0",
    releasedAmount: g.paidAmount ?? "0",
    status: escrowStatus(Number(g.status)),
    createdAt: Number(g.createdAt ?? 0) * 1000,
    duration: Math.max(0, deadlineSeconds - nowSeconds),
    deadlineAt: deadlineSeconds > 0 ? deadlineSeconds * 1000 : undefined,
    milestones,
    projectTitle: g.projectTitle ?? "",
    projectDescription: g.projectDescription ?? "",
  };
}

export function dedupeEscrows(deposited: GQLEscrow[], assigned: GQLEscrow[]): GQLEscrow[] {
  const seen = new Set<string>();
  const all: GQLEscrow[] = [];
  for (const e of [...deposited, ...assigned]) {
    const key = e.escrowId ?? e.id;
    if (!seen.has(key)) { seen.add(key); all.push(e); }
  }
  return all;
}
