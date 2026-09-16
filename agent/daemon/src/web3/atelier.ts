// atelier.ts — the only place Atelier actually writes to the Atelier contract.
//
// Writes go through the Atelier Agent Wallet's viem WalletClient (Circle MPC-backed,
// see circle/circleSigner.ts). `writeContract` ABI-encodes calldata the same way for
// any function shape — arrays, strings, structs — so the same MPC wallet that signs
// x402 payments also signs createEscrow's array/string params with no special
// handling. This is what resolves Phase 0's Spike A question: no hybrid custody
// (Agent Wallet for payments + separate hot wallet for contract calls) is needed.
//
// Reads go through a plain public client — no signing, no cost, no custody question.

import { createPublicClient, http, zeroAddress, type Abi, type PublicClient } from "viem";
import atelierAbi from "./AtelierABI.json" with { type: "json" };
import { arcTestnet, config, logRpcUrl, rpcUrl } from "../config.js";
import { createCircleSigner, type CircleSigner } from "../circle/circleSigner.js";

// Cast to viem's `Abi` type (not a tighter `as const` literal, since this is loaded
// from JSON) so `writeContract` can still resolve stateMutability (payable vs not)
// and accept `value` on `createEscrow` — a looser `unknown[]` cast defeats that.
const abi = atelierAbi as Abi;

// Arc's USDC precompile (config.usdcAddress) is a non-zero address, so Atelier's
// createEscrow treats it as an ERC20 (NATIVE_TOKEN in the contract is address(0) —
// see Atelier.sol): it requires msg.value === 0 and pulls funds itself via
// safeTransferFrom, which needs a prior `approve`. quoteDeposit's return is already
// in the token's own 6-decimal units — it is NOT a native `value` to attach.
const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

let publicClient: PublicClient | null = null;
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
  }
  return publicClient;
}

let logClient: PublicClient | null = null;
/**
 * The client for `eth_getLogs`, which is a different endpoint on purpose.
 *
 * See the note in config.ts: drpc answers reads all day and caps a log range at
 * somewhere under 200 blocks; rpc.testnet.arc.network is the only one that will
 * walk a real range and it rate-limits a bare eth_call. Pointing everything at
 * the second one to get logs is what put a freelancer's balance behind the
 * busiest queue on the network.
 *
 * Reads are constant and logs are occasional, so they are separated by how
 * often they happen rather than by what they return.
 */
export function getLogClient(): PublicClient {
  if (!logClient) {
    logClient =
      logRpcUrl === rpcUrl
        ? getPublicClient()
        : createPublicClient({ chain: arcTestnet, transport: http(logRpcUrl) });
  }
  return logClient;
}

export interface CreateEscrowParams {
  totalAmount: bigint; // in USDC base units (6 decimals)
  durationDays: bigint;
  milestoneAmounts: bigint[];
  milestoneDescriptions: string[];
  projectTitle: string;
  projectDescription: string; // briefHash embedded here — see BriefGenerator
  arbiters?: `0x${string}`[];
  requiredConfirmations?: bigint;
}

/** Posts an open job on Atelier (beneficiary = zero address = open for applications). Returns the escrowId. */
/**
 * Returns the new escrow id AND the creating transaction hash. The hash used to
 * be discarded, which meant the moment the money is actually locked — the
 * single most important payment in the whole story, and the one the pitch tells
 * a judge to click through to Arcscan — was never recorded in the payment feed
 * at all. Every "Locked in Escrow" row that ever appeared there came from an
 * unrelated event falling through a catch-all.
 */
/**
 * What funding a job of this size actually costs, fee included.
 *
 * Exported because a caller who is about to spend somebody else's custodial
 * balance has to be able to check it is there FIRST. Letting the transaction
 * discover it instead means a managed worker signs an approve, pays gas for it,
 * and then watches createEscrow revert — out of pocket, with no job and no
 * sentence explaining why.
 */
/**
 * Put this escrow to work while it waits — or decline to, once and for all.
 *
 * WHY IT LIVES ON THE CONTROLLER
 *
 * `setYieldOptIn` is on AtelierYield, not on the escrow contract, and the
 * controller's address is read off the escrow rather than configured — a
 * redeployed controller should not need an env var updated in three places, and
 * a stale one would silently write the term into a contract nobody consults.
 *
 * WHY THE DEPOSITOR HAS TO SIGN IT
 *
 * The controller rejects anybody else, which is the point: it is their capital
 * being deployed. Atelier can execute the instruction, the way it executes an
 * application or a delivery, but it cannot be the one deciding.
 */
export async function setYieldOptIn(
  escrowId: bigint,
  optedIn: boolean,
  /** Defaults to the agent's own wallet, which is the depositor on /api/hire. */
  signerOverride?: CircleSigner,
): Promise<`0x${string}`> {
  const signer = signerOverride ?? createCircleSigner();
  const client = getPublicClient();

  const controller = (await client.readContract({
    address: config.atelierAddress,
    abi,
    functionName: "yieldController",
  })) as `0x${string}`;

  if (/^0x0{40}$/i.test(controller)) {
    throw new Error("No yield controller is attached, so there is nothing to opt into.");
  }

  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: controller,
    abi: [
      {
        type: "function",
        name: "setYieldOptIn",
        stateMutability: "nonpayable",
        inputs: [{ type: "uint256" }, { type: "bool" }],
        outputs: [],
      },
    ] as const,
    functionName: "setYieldOptIn",
    args: [escrowId, optedIn],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Hand a job to a manager, signed by whoever owns it.
 *
 * Only ever existed in the browser, because only a browser client had ever
 * posted a job — the agent commissions work for itself and has no reason to
 * delegate. A managed worker posting one does: they chose Autopilot, and
 * without this their escrow would be funded and unmanaged, which is a manual
 * job wearing an Autopilot label.
 *
 * The depositor signs. That is the one-way key being handed over deliberately
 * by its owner, not Atelier appointing itself.
 */
export async function setJobManager(
  escrowId: bigint,
  manager: `0x${string}`,
  signer: CircleSigner,
): Promise<`0x${string}`> {
  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.atelierAddress,
    abi,
    functionName: "setJobManager",
    args: [escrowId, manager],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function quoteDeposit(totalAmount: bigint): Promise<{ deposit: bigint; fee: bigint }> {
  const [deposit, fee] = (await getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "quoteDeposit",
    args: [totalAmount],
  })) as [bigint, bigint];
  return { deposit, fee };
}

export async function createEscrow(
  params: CreateEscrowParams,
  /**
   * Who funds it, defaulting to the agent's own treasury.
   *
   * The depositor is whoever signs, and the depositor is the one the contract
   * answers to — refunds, cancellation, the yield term. So this is not a
   * plumbing detail: passing a different signer here changes whose money is at
   * stake and who holds the rights over it for the life of the job.
   *
   * The agent signs when an AI commissions work through /api/hire. A managed
   * worker's own wallet signs when they post a job themselves, which is the
   * whole point of letting somebody with no private key sit on either side of
   * the table.
   */
  signerOverride?: CircleSigner,
): Promise<{ escrowId: bigint; txHash: `0x${string}` }> {
  const signer = signerOverride ?? createCircleSigner();
  const client = getPublicClient();

  const [deposit] = (await client.readContract({
    address: config.atelierAddress,
    abi,
    functionName: "quoteDeposit",
    args: [params.totalAmount],
  })) as [bigint, bigint];

  // Approve Atelier to pull `deposit` (totalAmount + platform fee, in USDC's own
  // 6-decimal units) via safeTransferFrom — required before createEscrow will accept
  // a non-native token; sending it as msg.value instead reverts with InvalidAmount.
  const approveHash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [config.atelierAddress, deposit],
  });
  await client.waitForTransactionReceipt({ hash: approveHash });

  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.atelierAddress,
    abi,
    functionName: "createEscrow",
    args: [
      zeroAddress, // beneficiary — unset until an applicant is hired
      config.usdcAddress,
      params.totalAmount,
      params.durationDays,
      params.arbiters ?? [],
      params.requiredConfirmations ?? 0n,
      params.milestoneAmounts,
      params.milestoneDescriptions,
      params.projectTitle,
      params.projectDescription,
    ],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const created = receipt.logs.find((log) => log.address.toLowerCase() === config.atelierAddress.toLowerCase());
  if (!created) throw new Error(`createEscrow tx ${hash} mined but no Atelier log found`);

  // escrowId is nextEscrowId - 1 right after creation — simplest reliable read post-tx.
  const nextId = (await client.readContract({
    address: config.atelierAddress,
    abi,
    functionName: "nextEscrowId",
  })) as bigint;
  return { escrowId: nextId - 1n, txHash: hash };
}

/**
 * Every Atelier write, funnelled through one place.
 *
 * `as` is who signs. It defaults to the Atelier treasury, which is what every
 * call site did implicitly before — Atelier's own actions (hiring, approving,
 * rejecting, escalating) are unchanged and still go out as Atelier.
 *
 * Passing a different signer is what the managed-worker layer needs: applying
 * to a job and submitting work must be signed BY THE FREELANCER, because
 * Atelier authorises those on `msg.sender`. Atelier cannot apply on someone's
 * behalf from its own wallet — the contract would record Atelier as the
 * applicant. So the worker's own Circle wallet signs, on their instruction.
 */
async function write(
  functionName: string,
  args: readonly unknown[],
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  const hash = await as.walletClient.writeContract({
    chain: arcTestnet,
    account: as.address,
    address: config.atelierAddress,
    abi,
    functionName,
    args: args as unknown[],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

// ── Atelier's own actions (signed by the treasury) ───────────────────────────

export async function acceptFreelancer(escrowId: bigint, freelancer: `0x${string}`): Promise<`0x${string}`> {
  return write("acceptFreelancer", [escrowId, freelancer]);
}

export async function approveMilestone(escrowId: bigint, milestoneIndex: bigint): Promise<`0x${string}`> {
  return write("approveMilestone", [escrowId, milestoneIndex]);
}

export async function rejectMilestone(escrowId: bigint, milestoneIndex: bigint, reason: string): Promise<`0x${string}`> {
  return write("rejectMilestone", [escrowId, milestoneIndex, reason]);
}

/** Human-arbiter escalation path — Atelier's one-way key can never do this itself; it only calls it after max revisions. */
export async function disputeMilestone(escrowId: bigint, milestoneIndex: bigint, reason: string): Promise<`0x${string}`> {
  return write("disputeMilestone", [escrowId, milestoneIndex, reason]);
}

// ── A freelancer's own actions (signed by THEIR wallet) ─────────────────────
// Atelier authorises each of these on msg.sender, so the signer here is the
// freelancer, never Atelier. In managed mode that wallet is a Circle MPC wallet
// Atelier provisioned for them; in bring-your-own mode these never run at all
// because the freelancer signs from their own wallet via Atelier's dApp.

export async function applyToJob(
  escrowId: bigint,
  coverLetter: string,
  proposedTimelineDays: bigint,
  as: CircleSigner,
): Promise<`0x${string}`> {
  return write("applyToJob", [escrowId, coverLetter, proposedTimelineDays], as);
}

export async function startWork(escrowId: bigint, as: CircleSigner): Promise<`0x${string}`> {
  return write("startWork", [escrowId], as);
}

export async function submitMilestone(
  escrowId: bigint,
  milestoneIndex: bigint,
  description: string,
  as: CircleSigner,
): Promise<`0x${string}`> {
  return write("submitMilestone", [escrowId, milestoneIndex, description], as);
}

/**
 * On-chain reputation. Present in the ABI and previously unused — this is what
 * makes Atelier's reputation real rather than derived: humans and clients rating
 * each other on the contract, readable by anyone, not computed from our own
 * database.
 */
export async function submitRating(
  escrowId: bigint,
  /** uint8, 1–5. Clamped here rather than trusted — the contract would revert, and a
   *  revert on the rating would look like the payment itself failed. */
  score: number,
  review: string,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  return write("submitRating", [escrowId, clamped, review], as);
}

/**
 * Returns (averageX100, count) — the contract stores the average multiplied by
 * 100 to keep a fraction in an integer, so 470 means 4.70 stars over `count`
 * ratings. Reading it wrong by a factor of 100 would put "470 stars" on screen.
 */
export async function getAverageRating(who: `0x${string}`): Promise<{ average: number; count: number }> {
  const [averageX100, count] = (await getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "getAverageRating",
    args: [who],
  })) as [bigint, bigint];
  return { average: Number(averageX100) / 100, count: Number(count) };
}

// ── Getting the money back out ──────────────────────────────────────────────
// These exist on the contract and were never wired, which left real funds
// stranded: a job that attracts no suitable applicant keeps its budget locked
// in escrow with no recovery path. Several of ours are sitting like that now.
//
// This matters beyond bookkeeping. Atelier's central claim is that no machine in
// the chain can take your money — and the honest completion of that claim is
// that money nobody earned comes back, rather than staying locked forever
// because we never implemented the return path.

/**
 * Cancel an unfilled job and return its budget to whoever funded it.
 *
 * Only valid before a freelancer is hired — once someone is working, their
 * claim on the escrow is exactly what makes Atelier trustworthy, and the
 * contract enforces that.
 */
export async function cancelJob(escrowId: bigint, as: CircleSigner = createCircleSigner()): Promise<`0x${string}`> {
  return write("cancelJob", [escrowId], as);
}

/**
 * What an arbiter actually awarded, in the contract's own words.
 *
 * Every previous version of the settlement inferred this. The first read the
 * brief and announced "$2.50 each" when the arbiter had awarded $1.25. The
 * second read `totalAmount` and concluded $3.70 had come back when nothing
 * had — `totalAmount` is not decremented for the client's share, so it cannot
 * answer this question either.
 *
 * Atelier emits the answer directly:
 *
 *   DisputeResolved(escrowId, milestoneIndex, arbiter, freelancerAmount,
 *                   clientAmount, timestamp)
 *
 * Two numbers, stated by the contract at the moment it moved the money, and
 * verifiable against the USDC Transfer log in the same block. There is nothing
 * left to infer.
 *
 * Scanned backwards in widening windows because the poller notices a
 * resolution within seconds of it landing — the event is almost always in the
 * most recent chunk, and the wider passes only exist so a daemon that was
 * asleep still finds it.
 */
/* Above this many escrows, asking each one is worse than walking the logs. */
const MAX_DIRECT_ESCROW_SCAN = 400n;

export interface DisputeAward {
  milestoneIndex: number;
  freelancerAmount: number;
  clientAmount: number;
  blockNumber: bigint;
}

const DISPUTE_RESOLVED = {
  type: "event",
  name: "DisputeResolved",
  inputs: [
    { name: "escrowId", type: "uint256", indexed: true },
    { name: "milestoneIndex", type: "uint256", indexed: true },
    { name: "arbiter", type: "address", indexed: true },
    { name: "freelancerAmount", type: "uint256", indexed: false },
    { name: "clientAmount", type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

/**
 * Arc's RPC refuses any getLogs range wider than this. Measured, not guessed:
 * 9,000 blocks is accepted and 90,000 is rejected outright.
 *
 * The first version of this asked for 90k and 900k windows, got "RPC Request
 * failed" for both, swallowed it in a catch, and returned "no awards" — so the
 * settlement it fed looked like it worked and silently did nothing at all. A
 * range limit has to be respected by chunking, never by asking for more and
 * hoping.
 */
const LOG_WINDOW = 9_000n;

/** ~1.94 blocks/sec on Arc, so one window is roughly 75 minutes. */
export const CHUNKS_PER_DAY = 12;

async function scanDisputes(
  chunks: number,
  escrowId?: bigint,
): Promise<Map<string, Map<number, DisputeAward>>> {
  const pc = getLogClient();
  const head = await pc.getBlockNumber();
  const found = new Map<string, Map<number, DisputeAward>>();

  for (let i = 0; i < chunks; i++) {
    const toBlock = head - LOG_WINDOW * BigInt(i);
    if (toBlock <= 0n) break;
    const fromBlock = toBlock > LOG_WINDOW ? toBlock - LOG_WINDOW + 1n : 0n;
    let logs;
    try {
      logs = await pc.getLogs({
        address: config.atelierAddress as `0x${string}`,
        event: DISPUTE_RESOLVED,
        ...(escrowId === undefined ? {} : { args: { escrowId } }),
        fromBlock,
        toBlock,
      });
    } catch {
      continue; // a refused window is not an empty one — keep walking back
    }
    for (const l of logs) {
      const a = l.args as { escrowId?: bigint; milestoneIndex?: bigint; freelancerAmount?: bigint; clientAmount?: bigint };
      if (a.clientAmount === undefined || a.freelancerAmount === undefined) continue;
      const key = String(a.escrowId ?? escrowId ?? "");
      const forEscrow = found.get(key) ?? new Map<number, DisputeAward>();
      const idx = Number(a.milestoneIndex ?? 0n);
      forEscrow.set(idx, {
        milestoneIndex: idx,
        freelancerAmount: Number(a.freelancerAmount) / 1e6,
        clientAmount: Number(a.clientAmount) / 1e6,
        blockNumber: l.blockNumber ?? 0n,
      });
      found.set(key, forEscrow);
    }
    // Looking for one escrow and we have it: stop. A sweep keeps going.
    if (escrowId !== undefined && found.size) break;
  }
  return found;
}

/**
 * What the arbiter awarded on one escrow.
 *
 * A day deep by default. The poller notices a resolution within seconds, so the
 * award is nearly always in the newest window and the scan stops there — but a
 * daemon that was restarting when the arbiter ruled would otherwise never look
 * far enough back to find it, and the settlement would hang forever on an
 * escrow whose money had already moved. This costs a few seconds, and only
 * while a dispute is actually waiting to be settled.
 */
export async function disputeAwards(escrowId: bigint, chunks = CHUNKS_PER_DAY): Promise<DisputeAward[]> {
  const found = await scanDisputes(chunks, escrowId);
  const forEscrow = found.get(String(escrowId));
  return forEscrow ? [...forEscrow.values()].sort((a, b) => a.milestoneIndex - b.milestoneIndex) : [];
}

/**
 * Every award in recent history, keyed by escrow — one sweep for all of them.
 *
 * Used by the boot backfill, where asking per-escrow would multiply the same
 * chunked scan by the number of commissions.
 */
export async function recentDisputeAwards(chunks: number): Promise<Map<string, DisputeAward[]>> {
  const found = await scanDisputes(chunks);
  return new Map(
    [...found.entries()].map(([id, byIndex]) => [id, [...byIndex.values()].sort((a, b) => a.milestoneIndex - b.milestoneIndex)]),
  );
}

/**
 * Escalate a commission that has run past its deadline to a human arbiter.
 *
 * The path that was missing. A job whose delivery window has elapsed cannot be
 * cancelled (a freelancer has a claim) and cannot be emergency-refunded for
 * another 30 days — so nine commissions holding $79.60 sat "overdue" with no
 * route to resolution at all. Atelier built this for exactly that case.
 *
 * It does NOT refund. It hands the decision to a person, which is correct: a
 * freelancer who is late but delivered something should not be ruled against
 * automatically.
 */
export async function raiseOverdueDispute(
  escrowId: bigint,
  reason: string,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  return write("raiseOverdueDispute", [escrowId, reason.slice(0, 500)], as);
}

/** Last resort: reclaim after the deadline has passed, when a job stalled with work in progress. */
export async function emergencyRefundAfterDeadline(
  escrowId: bigint,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  return write("emergencyRefundAfterDeadline", [escrowId], as);
}

export async function getEscrow(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "getEscrow",
    args: [escrowId],
  });
}

/**
 * Has this address already applied to this job?
 *
 * Asked for by testers after they hit it: applying twice puts two applications
 * on-chain for one person, costs them gas twice, and gives the scorer the same
 * applicant to rank against themselves. The contract has always tracked this —
 * we simply never asked before letting someone spend a transaction.
 */
export async function hasApplied(escrowId: bigint, who: `0x${string}`): Promise<boolean> {
  return getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "hasApplied",
    args: [escrowId, who],
  }) as Promise<boolean>;
}

/**
 * Every job currently open for applications, straight from the chain.
 *
 * WHY THIS EXISTS
 *
 * The Telegram board read the daemon's own task table, so a freelancer in the
 * bot saw only jobs THIS agent had posted or adopted. A job commissioned by a
 * different agent, run manually by its client, or managed by another deployment
 * of this daemon was invisible to them — open, funded, and impossible to find —
 * while the web board, which reads the chain, listed it. Two doors into the same
 * marketplace showing different marketplaces.
 *
 * Open means: still Pending, nobody hired yet, deadline not passed. One
 * multicall for the escrows and one for the milestones, so the whole board is
 * two requests regardless of size.
 */
export async function openEscrows(): Promise<
  {
    escrowId: bigint;
    title: string;
    description: string;
    totalAmount: bigint;
    deadline: bigint;
    milestones: { description: string; amount: bigint }[];
  }[]
> {
  const client = getPublicClient();

  const next = (await client.readContract({
    address: config.atelierAddress,
    abi,
    functionName: "nextEscrowId",
  })) as bigint;

  if (next <= 1n) return [];
  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));

  const escrows = await client.multicall({
    contracts: ids.map((id) => ({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrow" as const,
      args: [id] as const,
    })),
    allowFailure: true,
  });

  /*
   * A failed read is skipped, not counted as "not open".
   *
   * This is a board, not an answer about one job: showing four of five open
   * jobs is a worse board, showing five of five is right, and claiming a job
   * does not exist because a read failed is the mistake this codebase keeps
   * paying for. The caller merges with the task table either way, so a gap here
   * degrades the list rather than emptying it.
   */
  const PENDING = 0;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const open: { id: bigint; esc: Record<string, unknown> }[] = [];
  for (let i = 0; i < ids.length; i++) {
    const r = escrows[i];
    if (r?.status !== "success") continue;
    const esc = r.result as {
      beneficiary: string;
      status: number;
      deadline: bigint;
      workStarted: boolean;
    };
    if (Number(esc.status) !== PENDING) continue;
    if (esc.workStarted) continue;
    if (!/^0x0{40}$/i.test(esc.beneficiary)) continue; // already hired
    if (esc.deadline <= now) continue;
    open.push({ id: ids[i]!, esc: esc as unknown as Record<string, unknown> });
  }
  if (open.length === 0) return [];

  const stages = await client.multicall({
    contracts: open.map(({ id }) => ({
      address: config.atelierAddress,
      abi,
      functionName: "getMilestones" as const,
      args: [id] as const,
    })),
    allowFailure: true,
  });

  return open.map(({ id, esc }, i) => {
    const ms = stages[i]?.status === "success"
      ? (stages[i]!.result as readonly { amount: bigint; requirements: string; description: string }[])
      : [];
    return {
      escrowId: id,
      title: String(esc.projectTitle ?? `Job #${id}`),
      description: String(esc.projectDescription ?? ""),
      totalAmount: esc.totalAmount as bigint,
      deadline: esc.deadline as bigint,
      milestones: ms.map((m) => ({
        description: m.requirements || m.description || "",
        amount: m.amount,
      })),
    };
  });
}

/**
 * Every escrow this address was hired for, straight from the chain.
 *
 * WHY THE CHAIN AND NOT THE TASK TABLE
 *
 * "What work is mine" was answered from the daemon's own task rows and its own
 * `applicant_accepted` decisions. Both are records of what the AGENT did, and
 * neither is the truth about who owes whom work.
 *
 * A client hired a freelancer themselves, from the app, and then took the job
 * back off Autopilot. Revoking deleted the task row, and with it the only thing
 * that had ever told the freelancer the job existed — while on-chain they were
 * still the named beneficiary of a funded escrow and still owed the work. Their
 * board went empty. The client's screen said the job was assigned to them.
 *
 * FreelancerAccepted is indexed on the freelancer, so the chain can answer this
 * directly, for every hire, no matter who made it.
 */
export async function hiredEscrowsFor(who: `0x${string}`): Promise<bigint[]> {
  const client = getPublicClient();

  /*
   * ASK THE ESCROWS DIRECTLY BEFORE WALKING LOGS.
   *
   * The log walk below reads FreelancerAccepted from the deploy block, and both
   * public RPCs refuse a scan that size — one outright, one by rate limit. So
   * when the subgraph was also rate-limited, this returned an empty array and a
   * freelancer's finished job simply vanished off their board. An unavailable
   * source and an empty result looked identical, which is the same mistake that
   * cost an afternoon on applications.
   *
   * `beneficiary` is a plain read on a struct, and nextEscrowId bounds how many
   * there are. For a marketplace this size that is a handful of cheap calls
   * that work when nothing else does. The log walk stays for the day there are
   * too many escrows to ask one at a time.
   */
  try {
    const next = (await client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "nextEscrowId",
    })) as bigint;

    if (next <= MAX_DIRECT_ESCROW_SCAN) {
      const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));

      /*
       * One request, and every failure counted.
       *
       * This was a per-id readContract with `catch { return null }` around it,
       * which is the same mistake as the one the comment above describes, one
       * level further down. When the RPC answered `rate limit exceeded` — which
       * it does, precisely because this was N requests — every read failed,
       * every one became null, and the filter turned a pile of failures into a
       * clean empty array. The caller has no way to tell that apart from "this
       * person was never hired", so it reported `answered: true` and a
       * freelancer's finished job disappeared off their board.
       *
       * So: multicall3 for the N-into-1, and if ANY escrow did not answer we
       * did not learn what this person was hired for. Say nothing rather than
       * say nothing confidently.
       */
      const results = await client.multicall({
        contracts: ids.map((id) => ({
          address: config.atelierAddress,
          abi,
          functionName: "getEscrow" as const,
          args: [id] as const,
        })),
        allowFailure: true,
      });

      const unanswered = results.filter((r) => r.status !== "success").length;
      if (unanswered > 0) {
        throw new Error(
          `${unanswered} of ${ids.length} escrows did not answer — cannot tell who was hired`,
        );
      }

      return ids.filter((_, i) => {
        const e = results[i]!.result as { beneficiary?: string };
        return e?.beneficiary?.toLowerCase() === who.toLowerCase();
      });
    }
  } catch (err) {
    /* Fall through to the log walk — a second source, not a shrug. If it fails
       too, the throw leaves this function and the caller reports that nobody
       answered, which is the truth. */
    console.warn(
      "[chain] direct escrow scan could not answer, trying the log walk:",
      err instanceof Error ? err.message : err,
    );
  }

  const event = {
    type: "event",
    name: "FreelancerAccepted",
    inputs: [
      { name: "escrowId", type: "uint256", indexed: true },
      { name: "freelancer", type: "address", indexed: true },
    ],
  } as const;

  /* The walk, not the reads above: a different endpoint, because the one that
     answers reads caps a log range under 200 blocks. */
  const logs_ = getLogClient();
  const latest = await logs_.getBlockNumber();
  const found = new Set<bigint>();

  // Windowed: public RPCs cap a getLogs range and refuse a wide one outright
  // rather than truncating it.
  for (let from = config.atelierDeployBlock; from <= latest; from += config.logRangeLimit + 1n) {
    const to = from + config.logRangeLimit > latest ? latest : from + config.logRangeLimit;
    const logs = await logs_.getLogs({
      address: config.atelierAddress,
      event,
      args: { freelancer: who },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const id = (log as { args?: { escrowId?: bigint } }).args?.escrowId;
      if (id != null) found.add(id);
    }
  }

  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every milestone with its amount and status — the only reliable answer to "is money still at stake". */
/** The agent managing this job, or null when the client runs it themselves. */
export async function jobManagerOf(escrowId: bigint): Promise<`0x${string}` | null> {
  const who = (await getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "jobManager",
    args: [escrowId],
  })) as `0x${string}`;
  return /^0x0+$/i.test(who) ? null : who;
}

export async function getMilestones(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "getMilestones",
    args: [escrowId],
  });
}

export async function getEscrowApplications(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.atelierAddress,
    abi,
    functionName: "getEscrowApplications",
    args: [escrowId],
  }) as Promise<`0x${string}`[]>;
}

export function explorerUrl(txHash: string): string {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}
