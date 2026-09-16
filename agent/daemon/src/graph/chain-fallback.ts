// chain-fallback.ts — answer the subgraph's questions from the chain itself.
//
// WHY THIS EXISTS
//
// The hire loop reads applications and escrow state through the subgraph, and
// graphQuery throws when GRAPH_URL is unset. The poller's very first step for a
// posted job is that call, so with no subgraph deployed nothing was ever
// scored, nobody was ever hired, and the failure looked like the agent being
// idle rather than a missing dependency. A running end-to-end demo should not
// require an indexer to have been deployed first.
//
// The subgraph stays the fast path: it serves lists, history and cross-escrow
// queries far better than RPC can. This covers the two single-escrow reads the
// hire loop cannot proceed without, so the product degrades in speed rather
// than stopping.
//
// Cover letters are the one field with no getter -- the contract stores only
// the applicant addresses and puts the letter in the event -- so those come
// from logs, walked in windows because public RPCs cap a getLogs range.
import { getAddress, type Abi } from "viem";
import atelierAbi from "../web3/AtelierABI.json" with { type: "json" };
import { config } from "../config.js";
import { getLogClient, getPublicClient } from "../web3/atelier.js";
import type { GQLApplication, GQLEscrow, GQLMilestone } from "./queries.js";

const abi = atelierAbi as Abi;

interface RawEscrow {
  depositor: string;
  beneficiary: string;
  token: string;
  totalAmount: bigint;
  paidAmount: bigint;
  deadline: bigint;
  status: number;
  workStarted: boolean;
  platformFee: bigint;
  arbiters: readonly string[];
  requiredConfirmations: bigint;
  isOpenJob: boolean;
  projectTitle: string;
  projectDescription: string;
}

interface RawMilestone {
  amount: bigint;
  description: string;
  requirements: string;
  status: number;
  submittedAt: bigint;
  approvedAt: bigint;
}

/** Cover letters keyed by applicant, read from ApplicationSubmitted logs. */
async function applicationDetails(
  escrowId: string,
): Promise<Map<string, { coverLetter: string; proposedTimeline: string; timestamp: string }>> {
  /* A log walk, so the endpoint that answers log walks. */
  const client = getLogClient();
  const event = {
    type: "event",
    name: "ApplicationSubmitted",
    inputs: [
      { name: "escrowId", type: "uint256", indexed: true },
      { name: "freelancer", type: "address", indexed: true },
      { name: "coverLetter", type: "string", indexed: false },
      { name: "proposedTimeline", type: "uint256", indexed: false },
    ],
  } as const;

  const out = new Map<string, { coverLetter: string; proposedTimeline: string; timestamp: string }>();
  const latest = await client.getBlockNumber();

  for (let from = config.atelierDeployBlock; from <= latest; from += config.logRangeLimit + 1n) {
    const to = from + config.logRangeLimit > latest ? latest : from + config.logRangeLimit;
    const logs = await client.getLogs({
      address: config.atelierAddress,
      event,
      args: { escrowId: BigInt(escrowId) },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const a = (log as { args?: Record<string, unknown> }).args;
      if (!a?.freelancer) continue;
      out.set(getAddress(String(a.freelancer)).toLowerCase(), {
        coverLetter: String(a.coverLetter ?? ""),
        proposedTimeline: String(a.proposedTimeline ?? "0"),
        // Block number rather than a wall clock. Only ordering is used, and a
        // timestamp per log would be one extra RPC round trip each.
        timestamp: String(log.blockNumber ?? 0n),
      });
    }
  }
  return out;
}

export async function applicationsFromChain(
  escrowId: string,
): Promise<{ escrow: { escrowId: string; status: number; applications: GQLApplication[] } | null }> {
  const client = getPublicClient();

  const [addresses, esc] = await Promise.all([
    client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrowApplications",
      args: [BigInt(escrowId)],
    }) as Promise<readonly string[]>,
    client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrow",
      args: [BigInt(escrowId)],
    }) as Promise<RawEscrow>,
  ]);

  // Only pay for the log walk when somebody has actually applied.
  const details = addresses.length > 0 ? await applicationDetails(escrowId) : new Map();

  const applications: GQLApplication[] = addresses.map((who) => {
    const d = details.get(who.toLowerCase());
    return {
      freelancer: who.toLowerCase(),
      coverLetter: d?.coverLetter ?? "",
      proposedTimeline: d?.proposedTimeline ?? "0",
      timestamp: d?.timestamp ?? "0",
    };
  });

  return { escrow: { escrowId, status: Number(esc.status), applications } };
}

export async function escrowFromChain(escrowId: string): Promise<{ escrow: GQLEscrow | null }> {
  const client = getPublicClient();

  const [esc, rawMilestones, apps] = await Promise.all([
    client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrow",
      args: [BigInt(escrowId)],
    }) as Promise<RawEscrow>,
    client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getMilestones",
      args: [BigInt(escrowId)],
    }) as Promise<readonly RawMilestone[]>,
    applicationsFromChain(escrowId),
  ]);

  // An escrow that was never created reads back as the zero struct rather than
  // reverting, and the callers treat null as "not indexed yet" and retry.
  if (esc.depositor === "0x0000000000000000000000000000000000000000") return { escrow: null };

  const milestones: GQLMilestone[] = rawMilestones.map((m, i) => ({
    milestoneIndex: String(i),
    amount: m.amount.toString(),
    description: m.description,
    status: Number(m.status),
    submittedAt: m.submittedAt > 0n ? m.submittedAt.toString() : null,
    approvedAt: m.approvedAt > 0n ? m.approvedAt.toString() : null,
  }));

  return {
    escrow: {
      id: escrowId,
      escrowId,
      depositor: esc.depositor.toLowerCase(),
      beneficiary: esc.beneficiary.toLowerCase(),
      token: esc.token.toLowerCase(),
      totalAmount: esc.totalAmount.toString(),
      paidAmount: esc.paidAmount.toString(),
      deadline: esc.deadline.toString(),
      status: Number(esc.status),
      isOpenJob: esc.isOpenJob,
      projectTitle: esc.projectTitle,
      projectDescription: esc.projectDescription,
      // Not on chain. Only ever used for display ordering, and the subgraph
      // supplies the real value whenever it is deployed.
      createdAt: "0",
      milestones,
      applications: apps.escrow?.applications ?? [],
    },
  };
}
