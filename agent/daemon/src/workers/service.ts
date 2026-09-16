// service.ts — everything a human can do, independent of how they reached us.
//
// This is the actual feature. The web page and the Telegram bot are both thin
// shells over these five functions; neither knows anything the other doesn't.
// Keeping the surface out of here is what makes the second door cost a day
// instead of a week, and what lets us change our minds about surfaces later.
//
// The architectural property that makes all of this cheap: Atelier's poller reads
// the Atelier subgraph, not a list of applicants it maintains. It has no idea
// who produced an application. So a worker applying through this service flows
// into reviewApplications → acceptFreelancer → reviewMilestone → approveMilestone
// with zero changes to the scorer, the reviewer, the agent, the store, the SSE
// stream, or the frontend. The agent genuinely cannot tell which door
// someone came through — and doesn't need to.

import crypto from "node:crypto";
import * as store from "../store.js";
import { publishWorkerEvent } from "../events.js";
import { criteriaFor as handoverCriteriaFor, previewCriteria } from "../agent/handover.js";
import * as atelier from "../web3/atelier.js";
import { createSignerFor, signMessageAsWallet } from "../circle/circleSigner.js";
import { config } from "../config.js";
import { categoryLabel, categoryOf } from "../categories.js";
import { dripGas, provisionWorkerWallet, workerBalance, withdrawTo } from "./wallets.js";

/**
 * An error whose message was written to be read by the person who caused it.
 *
 * The API sanitises errors before returning them, which is right for raw upstream
 * failures (a provider 401 has no business in an HTTP response) and wrong for
 * these: "that portfolio link doesn't look like a URL" is already the most useful
 * thing we could say, and it was being replaced with "Could not open this
 * commission. The failure has been logged." — unhelpful, and about a commission
 * on an endpoint that has nothing to do with commissions.
 */
export class UserFacingError extends Error {}

export interface JoinParams {
  handle: string;
  channel: "web" | "telegram";
  channelRef?: string;
  skills?: string;
  /** Bring-your-own-wallet: they already have an address and will sign for themselves. */
  ownAddress?: `0x${string}`;
}

/**
 * Join Atelier.
 *
 * Managed mode (the default) provisions a real MPC wallet and drips enough for
 * gas, and the person is never told either happened — because why would you tell
 * them. Bring-your-own mode records their address and provisions nothing; for
 * those users Atelier is a notifier and coordinator, never a custodian.
 */
export async function join(params: JoinParams): Promise<store.WorkerRow> {
  const handle = params.handle.trim();
  if (!handle) throw new UserFacingError("A handle is required — it's the only thing you have to choose.");
  if (handle.length > 40) throw new UserFacingError("That handle is too long (40 characters max).");

  /*
   * Normalised before it is ever stored or looked up.
   *
   * The wallet a person gets is keyed on this string, so any two spellings of
   * the same identity are two wallets — and the one holding their money is the
   * one they can no longer reach. Lowercasing costs nothing and removes a whole
   * class of "my balance disappeared".
   */
  const channelRef = params.channelRef?.trim().toLowerCase() || undefined;

  if (channelRef) {
    const existing = store.getWorkerByChannelRef(params.channel, channelRef);
    if (existing) return existing; // idempotent: tapping "join" twice is not two people
  }

  const id = crypto.randomUUID();

  if (params.ownAddress) {
    return store.insertWorker({
      id,
      handle,
      channel: params.channel,
      channelRef: channelRef ?? null,
      skills: params.skills ?? null,
      walletId: null,
      walletAddress: requireAddress(params.ownAddress, "wallet address"),
      mode: "own",
    });
  }

  const wallet = await provisionWorkerWallet();
  const worker = store.insertWorker({
    id,
    handle,
    channel: params.channel,
    channelRef: channelRef ?? null,
    skills: params.skills ?? null,
    walletId: wallet.walletId,
    walletAddress: wallet.address,
    mode: "managed",
  });

  // Non-blocking: they are a real worker the moment the row exists. If the drip
  // fails they'll hit it when they act, which is a far better place to surface
  // it than the front door.
  void dripGas(wallet.address);

  return worker;
}

export interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  /** What kind of work this is, or null for jobs posted before categories. */
  category: string | null;
  /** How the budget is split, so a worker can see they're paid in stages. */
  milestones: { description: string; amount: number }[];
  /** When applications close and the agent judges them together. */
  closesAt: number;
  /** Only set when a worker was supplied — lets a surface hide "Apply" on ones they've taken. */
  alreadyApplied?: boolean;
}

/** Open commissions, optionally marked up for one worker. */
/**
 * The board, from the daemon's own jobs only.
 *
 * Kept separate because it is synchronous and free, and the merged board below
 * builds on it. Everything the agent posted or adopted carries a real brief —
 * criteria, stages, an application window — which the chain alone cannot give.
 */
export function ownQuests(): Quest[] {
  return store
    // Same reason as the poller's window: open jobs are filtered out of the
    // most-recent N, so N has to outrun the finished ones stacking up in front.
    .listTasks(300)
    .filter((t) => t.status === "posted" && t.escrowId && t.briefJson)
    .map((t) => {
      const brief = JSON.parse(t.briefJson as string);
      const windowMinutes = (brief.applicationWindowMinutes as number | undefined) ?? config.applicationWindowMinutes;
      return {
        escrowId: t.escrowId as string,
        title: brief.title as string,
        budget: brief.budget as number,
        durationDays: brief.durationDays as number,
        criteria: (brief.criteria ?? []) as string[],
        // Read from the instruction the escrow was created with, so a Telegram
        // freelancer sees the same label the web board shows.
        category: categoryLabel(categoryOf(t.instruction)),
        milestones: (brief.milestones ?? []) as { description: string; amount: number }[],
        closesAt: t.createdAt + windowMinutes * 60_000,
      };
    });
}

/**
 * EVERY OPEN JOB, NOT JUST THIS AGENT'S.
 *
 * The Telegram board read the task table and nothing else, so a freelancer in
 * the bot saw only jobs THIS daemon had posted or adopted. A job commissioned by
 * another agent, run manually by its client, or managed by a different
 * deployment of this same daemon was open, funded, and invisible to them — while
 * the web board, which reads the chain, listed it. Two doors into one
 * marketplace, showing different marketplaces, and the codebase says in three
 * places that both doors are supposed to be the same door.
 *
 * The task table still wins where it has a row: it holds the generated brief,
 * the acceptance criteria and the application window, none of which exist
 * on-chain. The chain fills in everything else, described from the escrow's own
 * title, description and milestones.
 *
 * A chain read that fails leaves the agent's own jobs listed rather than
 * emptying the board — the merge is additive in both directions.
 */
export async function openQuests(): Promise<Quest[]> {
  const own = ownQuests();
  const mine = new Set(own.map((q) => q.escrowId));

  let onChain: Awaited<ReturnType<typeof atelier.openEscrows>>;
  try {
    onChain = await atelier.openEscrows();
  } catch (err) {
    console.warn(
      "[quests] chain could not list open jobs, showing this agent's own:",
      err instanceof Error ? err.message : err,
    );
    return own;
  }

  const extra: Quest[] = onChain
    .filter((e) => !mine.has(e.escrowId.toString()))
    .map((e) => {
      const deadlineMs = Number(e.deadline) * 1000;
      return {
        escrowId: e.escrowId.toString(),
        title: e.title,
        budget: Number(e.totalAmount) / 1e6,
        /* From the escrow's own deadline, rounded up, so a job with hours left
           reads as a day rather than as zero. */
        durationDays: Math.max(1, Math.ceil((deadlineMs - Date.now()) / 86_400_000)),
        /* The criteria live in the brief, which only exists for jobs this agent
           holds. Saying nothing is better than inventing acceptance criteria
           somebody could be judged against. */
        criteria: [],
        category: categoryLabel(categoryOf(e.description)),
        milestones: e.milestones.map((m) => ({
          description: m.description,
          amount: Number(m.amount) / 1e6,
        })),
        /* No application window on chain: the client or their agent decides when
           to judge. The deadline is the honest outer bound. */
        closesAt: deadlineMs,
      };
    });

  return [...own, ...extra];
}

/**
 * The same board, marked with what this person has already applied to.
 *
 * Separate from openQuests() because it costs one chain read per job: the plain
 * list is used on every poll and by anonymous visitors, and making that pay for
 * a personalisation nobody asked for would be the wrong default.
 */
export async function openQuestsFor(workerId: string): Promise<Quest[]> {
  const worker = store.getWorker(workerId);
  const quests = await openQuests();
  if (!worker?.walletAddress) return quests;
  const address = worker.walletAddress as `0x${string}`;
  return Promise.all(
    quests.map(async (q) => {
      try {
        return { ...q, alreadyApplied: await atelier.hasApplied(BigInt(q.escrowId), address) };
      } catch {
        return q; // a chain hiccup must not empty someone's job board
      }
    }),
  );
}

/**
 * Make sure a worker can actually pay for the transaction they're about to sign.
 *
 * The gas drip on signup is deliberately non-blocking, which means someone who
 * joins and immediately applies can get there before their own funding has
 * confirmed. Found by doing exactly that: the first apply failed and the second,
 * four seconds later, worked.
 *
 * Worse than the failure was the message. The raw error says "insufficient
 * funds", which the API's sanitiser matched to its treasury rule and rendered as
 * "Atelier's treasury doesn't hold enough USDC" — telling a freelancer that OUR
 * wallet was empty when the issue was a drip in flight to theirs.
 */
async function ensureGas(worker: store.WorkerRow): Promise<void> {
  if (worker.mode === "own" || !worker.walletAddress) return;
  const address = worker.walletAddress as `0x${string}`;
  try {
    if (Number(await workerBalance(address)) >= MIN_GAS_USDC) return;
    await dripGas(address); // awaited here, unlike signup — they are mid-action
    if (Number(await workerBalance(address)) >= MIN_GAS_USDC) return;
  } catch {
    // fall through to the message below rather than surfacing a chain error
  }
  throw new UserFacingError(
    "Your wallet is still being funded for network fees — give it about ten seconds and try again. Nothing was lost.",
  );
}

/** Enough to sign with. Arc fees are tiny; this is a floor, not a target. */
const MIN_GAS_USDC = Number(process.env.WORKER_MIN_GAS_USDC ?? 0.01);

function signerFor(worker: store.WorkerRow) {
  if (worker.mode === "own") {
    throw new UserFacingError(
      "You signed up with your own wallet, so Atelier can't sign for you — apply from Atelier with your wallet and Atelier will still see it.",
    );
  }
  if (!worker.walletAddress) throw new UserFacingError("No wallet on this account yet.");
  return createSignerFor(worker.walletAddress as `0x${string}`);
}

/**
 * Apply to a commission.
 *
 * The freelancer's OWN wallet signs this, not Atelier's — Atelier authorises
 * applyToJob on msg.sender, so an application signed by Atelier would record
 * Atelier as the applicant. Their tap is the instruction; Atelier is the broker
 * executing it in their name.
 */
/**
 * How long the applicant says they need.
 *
 * Both surfaces hard-coded 3. The scorer gives 15 points for a realistic
 * timeline and compares this against the brief's duration — so every applicant
 * to a 1-day or 2-day job automatically lost all 15 for a number they never
 * chose and were never shown. A real person applying to a one-day brief was
 * told their proposed 3 days "exceeds the brief's duration"; they had proposed
 * nothing at all.
 *
 * Defaulting to the brief's OWN duration is the honest reading of an applicant
 * who didn't specify: they are applying to the job as advertised, so they are
 * saying they can meet the deadline in it.
 */
async function defaultTimelineFor(escrowId: string): Promise<number> {
  const task = store.listTasks(300).find((t) => t.escrowId === escrowId);
  if (!task?.briefJson) return 3;
  try {
    const days = Number(JSON.parse(task.briefJson).durationDays);
    return Number.isFinite(days) && days > 0 ? days : 3;
  } catch {
    return 3;
  }
}

export async function apply(
  workerId: string,
  escrowId: string,
  coverLetter: string,
  /** Omit to say "I can do it in the time you asked for". */
  proposedTimelineDays: number | undefined,
  /**
   * A link to past work — portfolio, CV, Behance, a repo, anything.
   *
   * Testers asked for this: with only a text box, everyone sounds equally
   * confident and the only thing separating applicants is how well they write.
   * Someone with ten years of logos had no way to show it.
   *
   * A LINK rather than an upload, deliberately. Atelier has no file storage, and
   * the obvious shortcut — accepting a Telegram upload and putting its URL
   * on-chain — would be a security hole: Telegram's file URLs embed the bot
   * token, so that would publish our credentials permanently on a public chain.
   * A link the applicant already controls is both safer and more durable.
   */
  portfolioUrl?: string,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  const letter = coverLetter.trim();
  if (!letter) throw new UserFacingError("Write a short note about why you're right for this one.");

  const portfolio = portfolioUrl?.trim();
  if (portfolio && !/^https?:\/\/\S+$/i.test(portfolio)) {
    throw new UserFacingError("That portfolio link doesn't look like a URL — it should start with http:// or https://");
  }

  // Check BEFORE spending their gas. The contract tracks this and would happily
  // record a second application: two rows on-chain for one person, gas paid
  // twice, and the scorer ranking someone against themselves.
  const signer = signerFor(worker);
  await ensureGas(worker);
  if (await atelier.hasApplied(BigInt(escrowId), signer.address)) {
    throw new UserFacingError(
      "You've already applied to this one — the agent has your application and will come back to you either way.",
    );
  }

  // Labelled rather than concatenated, so the scorer can tell the applicant's
  // own words from a link they provided, and so the link survives as something
  // readable on-chain and on Atelier's own interface.
  const full = portfolio ? `${letter}\n\nPast work: ${portfolio}` : letter;

  const timeline = proposedTimelineDays ?? (await defaultTimelineFor(escrowId));
  const txHash = await atelier.applyToJob(BigInt(escrowId), full, BigInt(timeline), signer);
  return { txHash };
}

/**
 * Submit finished work for a milestone.
 *
 * `startWork` is called first and its failure swallowed on purpose: Atelier
 * requires the lifecycle step, but it reverts if the job is already in progress,
 * and a worker submitting their second milestone should not be shown a contract
 * error about a state transition that already happened.
 */
export async function submit(
  workerId: string,
  escrowId: string,
  description: string,
  /** Omit to send the next milestone that actually needs work — see resolveMilestone. */
  milestoneIndex?: number,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  const text = description.trim();
  if (!text) throw new UserFacingError("Describe what you're delivering, and include a link to the file.");

  /**
   * Are you actually the person hired for this job?
   *
   * Atelier answers this with Unauthorized(), which is correct and useless:
   * a freelancer typed /submit 61 for a job still open for applications that
   * they had never applied to, and got a raw viem stack trace — calldata,
   * gas estimation error, a link to the viem docs — after their gas had already
   * been spent. The contract was never going to accept it, and we knew that
   * before sending.
   *
   * So it is checked here, where the answer can be a sentence instead.
   */
  const wallet = worker.walletAddress?.toLowerCase();
  try {
    const escrow = (await atelier.getEscrow(BigInt(escrowId))) as { beneficiary?: string };
    const hired = (escrow?.beneficiary ?? "").toLowerCase();
    const nobodyHired = !hired || /^0x0{40}$/.test(hired);
    if (nobodyHired) {
      throw new UserFacingError(
        `Nobody has been hired for commission ${escrowId} yet — it's still taking applications, so there's nothing to deliver. ` +
          `Apply with /jobs, and I'll message you if you get it.`,
      );
    }
    if (wallet && hired !== wallet) {
      throw new UserFacingError(
        `Commission ${escrowId} went to a different freelancer, so only they can deliver it. ` +
          `/mine shows the jobs that are actually yours.`,
      );
    }
  } catch (err) {
    // A UserFacingError above is the answer; a chain read failing is not, and
    // must not block a legitimate delivery.
    if (err instanceof UserFacingError) throw err;
  }

  const index = milestoneIndex ?? (await resolveMilestone(escrowId));

  const signer = signerFor(worker);
  await ensureGas(worker);

  /*
   * Only start work that has not started.
   *
   * This sent startWork unconditionally and swallowed the revert, which meant
   * every delivery after the first paid for a whole extra transaction — MPC
   * signature, broadcast and wait — to be told something we could have read.
   * On testnet that is most of the minute a freelancer spends watching a
   * spinner after pressing submit.
   *
   * A failed read falls through to sending it, because the swallowed revert is
   * still the safe outcome and a stalled delivery is not.
   */
  let alreadyStarted = false;
  try {
    const esc = (await atelier.getEscrow(BigInt(escrowId))) as { workStarted?: boolean };
    alreadyStarted = esc.workStarted === true;
  } catch {
    /* unknown — send it and let the contract decide */
  }

  if (!alreadyStarted) {
    try {
      await atelier.startWork(BigInt(escrowId), signer);
    } catch {
      // already started — expected on every milestone after the first
    }
  }
  const txHash = await atelier.submitMilestone(BigInt(escrowId), BigInt(index), text, signer);

  /*
   * Tell somebody. Nothing here did.
   *
   * A submission is on-chain the moment this returns, and it was announced
   * nowhere: no bell in the web app, no Telegram message, no live update on the
   * client's dashboard. The client had bought something, had no idea it had
   * arrived, and found out by reloading the page on a hunch. The event type and
   * its Telegram handler both already existed — nothing ever published one.
   *
   * After the transaction, deliberately: the work is delivered whether or not
   * the announcement lands, and an undelivered courtesy must never fail a
   * delivery that already happened.
   */
  publishWorkerEvent({
    type: "work_submitted",
    message: "A freelancer has delivered their work — it is waiting on review.",
    escrowId: String(escrowId),
    txHash,
    timestamp: Date.now(),
  });

  return { txHash };
}

/**
 * Which milestone is a worker actually delivering?
 *
 * Both surfaces hard-coded 0. For the single-milestone jobs that make up almost
 * everything posted so far that was invisibly correct, and for anything staged
 * it was a dead end: milestone 0 gets approved, the worker sends stage two, it
 * goes to index 0 again, and the job can never reach the approved-milestone
 * count that marks it complete. Job #38 is a two-stage voiceover sitting open
 * right now, so this was a live trap rather than a hypothetical one.
 *
 * Resolved against the BRIEF's milestone count rather than the subgraph's list,
 * because the subgraph only indexes milestones that have been touched — a job
 * whose first stage was just approved comes back as a one-element list, and
 * "the next one" would be off the end of it.
 */
const MS_SUBMITTED = 1;
const MS_APPROVED = 2;
const MS_REJECTED = 3;

async function resolveMilestone(escrowId: string): Promise<number> {
  /*
   * How many stages there are is a chain fact.
   *
   * This counted the milestones in the daemon's own brief and assumed one when
   * there was no task row — so on a job the daemon holds no brief for (hired
   * on-chain, or taken back off Autopilot) every delivery was filed against
   * stage one, including the second stage of a two-stage job. The escrow knows
   * how many it has.
   */
  let expected = 0;
  /*
   * The same read answers both questions, so it is kept.
   *
   * The status walk below used to re-ask the SUBGRAPH which stages were done,
   * with `catch { return 0 }` around it — so a 429 pointed every delivery, and
   * every "how did this end" panel, at stage one. That is how a freelancer
   * whose SECOND stage had been taken off them by an arbiter was shown "Approved
   * and paid in full. Nothing further is needed from you on this one": the panel
   * was reading the wrong stage, and the wrong stage had gone fine.
   *
   * The chain has already answered here. Asking a second, flakier source the
   * same question was only ever a way to get a worse answer.
   */
  let onChainStatuses: number[] | null = null;
  try {
    const onChain = (await atelier.getMilestones(BigInt(escrowId))) as readonly { status: number }[];
    expected = onChain.length;
    onChainStatuses = onChain.map((m) => Number(m.status));
  } catch {
    /* fall through to the brief */
  }

  if (expected === 0) {
    const task = store.listTasks(100).find((t) => t.escrowId === escrowId);
    expected = 1;
    if (task?.briefJson) {
      try {
        const b = JSON.parse(task.briefJson);
        if (Array.isArray(b.milestones) && b.milestones.length > 0) expected = b.milestones.length;
      } catch {
        /* a malformed brief just means we assume one stage */
      }
    }
  }
  if (expected === 1) return 0;

  const pick = (byIndex: Map<number, number>): number => {
    for (let i = 0; i < expected; i++) {
      const status = byIndex.get(i) ?? 0; // never touched = still to do
      if (status !== MS_SUBMITTED && status !== MS_APPROVED) return i; // pending or sent back for revision
    }
    // Everything is either awaiting review or already settled. The last stage is
    // the only sensible reading of both "here is my work" and "how did this end".
    return expected - 1;
  };

  if (onChainStatuses) {
    return pick(new Map(onChainStatuses.map((status, i) => [i, status])));
  }

  try {
    const { graphQuery } = await import("../graph/client.js");
    const { GET_JOB_BY_ID } = await import("../graph/queries.js");
    const result = await graphQuery<{ escrow: { milestones: { milestoneIndex: number; status: number }[] } | null }>(GET_JOB_BY_ID, { escrowId });
    return pick(new Map((result.escrow?.milestones ?? []).map((m) => [Number(m.milestoneIndex), Number(m.status)])));
  } catch {
    return 0; // nothing could say: stage one is right for most jobs
  }
}

/**
 * Everything this person is involved in, and where it stands.
 *
 * Built from the decision log and task list rather than new bookkeeping — the
 * hire is already recorded there for the command center, so a worker's view of
 * their own jobs is a different reading of the same facts, not a second copy of
 * them that could drift.
 */
export type WorkState = "applied" | "hired" | "completed" | "disputed" | "lost";

export interface WorkRow {
  escrowId: string;
  title: string;
  budget: number;
  status: string;
  icon: string;
  state: WorkState;
  /** Milestones delivered and waiting on a verdict. */
  awaitingReview: number;
  /** Milestones already approved and paid. */
  approved: number;
  /**
   * Total stages on this job — meaningful only when `stagesKnown`.
   *
   * Zero here has two readings and the difference matters: a job with no stages
   * yet, or a milestone read that did not come back. See `stagesKnown`.
   */
  milestoneCount: number;
  /** Stages sent back for changes. */
  needsRevision: number;
  /**
   * Stages a human arbiter closed, whoever won.
   *
   * Separate from `approved` because the contract is not: `resolveDispute` sets
   * the milestone to Approved either way, so counting on status alone reports a
   * stage taken off the freelancer as work they were paid for.
   */
  arbitrated: number;
  /** USDC that actually reached this freelancer, or null if the stages were unread. */
  earnedUsdc: number | null;
  /** False when every stage has been delivered — nothing left to send. */
  canSubmit: boolean;
  /**
   * Whether the stage counts above were actually read.
   *
   * False means the chain did not answer for this job, so every count is a
   * placeholder rather than a figure. Without it, a rate-limited read looked
   * identical to "no stages approved yet" and the board told a freelancer whose
   * work was finished and paid for to go and send it again.
   */
  stagesKnown: boolean;
  /**
   * Who decides on a submission — and therefore how long it should take.
   *
   * A freelancer waiting on a verdict has no way to tell a machine that answers
   * in minutes from a person who answers when they next open the tab. Both look
   * identical from their side: silence. Saying which is not decoration, it is
   * the difference between waiting and worrying.
   */
  reviewer: "agent" | "client" | null;
}

/**
 * Which escrows this address is on — from the index, not by walking the chain.
 *
 * The chain walk this replaces read FreelancerAccepted logs from the contract's
 * deploy block in nine-thousand-block windows: seventy-six sequential round
 * trips, gaining one more every nine thousand blocks. A freelancer's board took
 * twenty seconds to open and was getting slower every day. This is the read an
 * index exists for.
 *
 * ONLY the escrow ids come from here. The subgraph creates milestone entities
 * when a milestone is first touched, so its milestone list is not the job's
 * milestone list — escrow 7 reads back as one stage worth nothing called
 * "everything", which is the submission, not the work. Counts and statuses stay
 * on the chain, where there are only ever a handful of rows to read.
 */
async function hiredEscrowIds(me: `0x${string}`): Promise<{ ids: string[]; answered: boolean }> {
  try {
    const { graphQuery, isGraphConfigured } = await import("../graph/client.js");
    if (isGraphConfigured()) {
      const { GET_JOBS_FOR_FREELANCER } = await import("../graph/queries.js");
      const res = await graphQuery<{ escrows: { escrowId: string }[] }>(
        GET_JOBS_FOR_FREELANCER,
        { who: me.toLowerCase() },
      );
      const ids = (res.escrows ?? []).map((e) => String(e.escrowId));

      /*
       * AN INDEX SAYING "NONE" IS NOT THE CHAIN SAYING "NONE".
       *
       * A non-empty list is trustworthy — it found real hires, and finding them
       * is the whole reason the subgraph is faster than walking the chain. An
       * EMPTY list is the one answer a lagging index produces that looks
       * exactly like the truth: Studio rate-limits this project under ordinary
       * use, and an index that is behind, re-syncing, or has not reached a
       * recent block returns no escrows and a perfectly valid 200.
       *
       * This was trusted absolutely, so a freelancer's finished job blinked off
       * their board roughly one poll in six while the chain, asked directly in
       * the same second, listed it. The fix is not to distrust the subgraph; it
       * is to confirm the single answer that cannot be told apart from a
       * failure. The chain check below is one multicall and only runs when the
       * index claims there is nothing.
       */
      if (ids.length > 0) return { ids, answered: true };
    }
  } catch (err) {
    console.warn(
      "[work] subgraph could not list hires, falling back to the chain:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    /* Reached either because the subgraph is unavailable, or because it said
       "none" and that is the one answer worth a second opinion. */
    const ids = await atelier.hiredEscrowsFor(me);
    return { ids: ids.map((id) => id.toString()), answered: true };
  } catch (err) {
    /*
     * NOBODY ANSWERED — which is not the same as "you have no work".
     *
     * This used to `.catch(() => [])`, so a rate-limited subgraph and a
     * refusing RPC together produced an empty array, and a freelancer's
     * finished job vanished off their board with no sign anything had gone
     * wrong. The caller needs to be able to tell the difference.
     */
    console.warn(
      "[work] neither the subgraph nor the chain could list hires:",
      err instanceof Error ? err.message : err,
    );
    return { ids: [], answered: false };
  }
}

export async function myWork(workerId: string): Promise<WorkRow[]> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) return [];
  const me = worker.walletAddress as `0x${string}`;

  /*
   * WHO WAS HIRED IS A CHAIN FACT, NOT A DAEMON FACT.
   *
   * This used to read the agent's own `applicant_accepted` decisions. A client
   * who hired someone themselves produced no such row, so the freelancer they
   * had just hired was listed as merely "applied" — and if the client also took
   * the job off Autopilot, the task row was deleted and the job vanished from
   * the freelancer's board entirely. They were the named beneficiary of a funded
   * escrow with no way to see it, while the client's screen showed it assigned
   * to them.
   */
  const { ids: hiredIds, answered } = await hiredEscrowIds(me);
  const hiredFor = new Set(hiredIds);

  /*
   * Candidates are the union of what the agent knows about and what the chain
   * says is ours. The task table is still the better source for a job the agent
   * is running — it carries the brief — but it can no longer be the only one.
   */
  const tasks = store.listTasks(100).filter((t) => t.escrowId && t.briefJson);
  const byEscrow = new Map(tasks.map((t) => [t.escrowId as string, t]));
  const candidateIds = [...new Set([...byEscrow.keys(), ...hiredFor])];

  // One chain read per job, run TOGETHER rather than one after another. As a
  // sequential loop this was up to 100 round trips before the first character of
  // output — several seconds of a bot that looks hung, growing every time anyone
  // posts a job. Nothing here depends on the previous answer, so nothing needed
  // to wait for it.
  const involvement = await Promise.all(
    candidateIds.map(async (escrowId) => {
      if (hiredFor.has(escrowId)) return { hired: true, applied: true, known: true };
      try {
        return { hired: false, applied: await atelier.hasApplied(BigInt(escrowId), me), known: true };
      } catch {
        /* A hiccup hides THIS row rather than breaking the list — but it is
           recorded as not-known, because "we could not ask" and "they are not
           involved" produce the same row and must not produce the same answer
           about the whole board. See the check after the loop. */
        return { hired: false, applied: false, known: false };
      }
    }),
  );

  /* A job we were hired for but hold no brief on still has to be listed, so its
     title and budget come from the escrow itself. */
  const needsEscrow = candidateIds.filter((id, i) => involvement[i]!.hired && !byEscrow.has(id));
  const escrows = new Map(
    (await Promise.all(
      needsEscrow.map(async (id) => {
        try {
          return [id, await atelier.getEscrow(BigInt(id))] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    )),
  );

  /*
   * WHAT HAPPENED TO WHAT I ALREADY SENT.
   *
   * The row said "You were hired — send your work" from the moment of hire
   * until the job closed, no matter what had been delivered. Someone submitted
   * a milestone, saw the same sentence and the same button, and sent the next
   * stage with no idea whether the first had even been looked at. Two
   * deliveries, one of them made blind.
   */
  /*
   * "APPROVED" ON CHAIN DOES NOT MEAN THE WORK WAS ACCEPTED.
   *
   * `resolveDispute` sets `m.status = MilestoneStatus.Approved` whoever won —
   * the contract uses Approved to mean "settled", and records who actually got
   * the money in `resolutionFreelancerAmount` / `resolutionClientAmount`.
   *
   * Counting those as approved told a freelancer that escrow 7 was "All 2
   * stage(s) approved and paid", when stage two had been resolved against them
   * and paid 2 USDC back to the client. They earned 3 of 5 and their board
   * congratulated them on earning all of it. A settled stage and a stage the
   * reviewer accepted are different facts, so they are counted separately and
   * `resolvedAt` is what tells them apart.
   */
  const progress = new Map<string, {
    awaiting: number;
    approved: number;
    rejected: number;
    arbitrated: number;
    count: number;
    /** USDC that actually reached this freelancer, across all stages. */
    earnedUsdc: number;
    /** USDC an arbiter sent back to the client instead. */
    lostUsdc: number;
  }>();
  const reviewers = new Map<string, "agent" | "client">();
  await Promise.all(
    candidateIds.map(async (escrowId, i) => {
      if (!involvement[i]!.hired) return;
      try {
        const ms = (await atelier.getMilestones(BigInt(escrowId))) as readonly {
          status: number;
          amount: bigint;
          resolvedAt: bigint;
          resolutionFreelancerAmount: bigint;
          resolutionClientAmount: bigint;
        }[];
        /* An arbiter touched it — whatever the status now says. */
        const arbitrated = (m: (typeof ms)[number]) => Number(m.resolvedAt ?? 0n) > 0;
        const usdc = (v: bigint | undefined) => Number(v ?? 0n) / 1e6;

        progress.set(escrowId, {
          awaiting: ms.filter((m) => Number(m.status) === MS_SUBMITTED).length,
          approved: ms.filter((m) => Number(m.status) === MS_APPROVED && !arbitrated(m)).length,
          rejected: ms.filter((m) => Number(m.status) === MS_REJECTED).length,
          arbitrated: ms.filter(arbitrated).length,
          count: ms.length,
          earnedUsdc: ms.reduce(
            (sum, m) =>
              sum +
              (arbitrated(m)
                ? usdc(m.resolutionFreelancerAmount)
                : Number(m.status) === MS_APPROVED
                  ? usdc(m.amount)
                  : 0),
            0,
          ),
          lostUsdc: ms.reduce(
            (sum, m) => sum + (arbitrated(m) ? usdc(m.resolutionClientAmount) : 0),
            0,
          ),
        });
      } catch {
        /* a chain hiccup leaves the row without a stage summary, not missing */
      }

      try {
        reviewers.set(escrowId, (await atelier.jobManagerOf(BigInt(escrowId))) ? "agent" : "client");
      } catch {
        /* unknown — say nothing rather than promise a reviewer we cannot confirm */
      }
    }),
  );

  /*
   * An empty board has to be earned.
   *
   * If nothing could tell us what this person was hired for and the daemon
   * holds no task rows either, we know nothing — and rendering "nothing on your
   * bench" would be a claim we cannot make. Failing is the honest answer; the
   * board shows it could not load and tries again on the next poll.
   */
  if (!answered && tasks.length === 0) {
    /* UserFacingError, not Error: clientError() replaces a plain message with a
       generic "Could not open this commission", and the whole point of this
       throw is the sentence it carries. Somebody whose board has just emptied
       needs to read "your work is safe", not a logging notice. */
    throw new UserFacingError(
      "Could not reach the job index or the chain just now — nothing is lost, this is a read problem. It will retry on its own.",
    );
  }

  /*
   * The same rule, for the other way in.
   *
   * The guard above only covers a daemon with no task rows at all. With task
   * rows and an unreachable chain, every candidate fell through to
   * `hasApplied`, every one of those failed, each became "not involved", and
   * the loop below dropped all of them — an empty board, returned as an answer,
   * a 200, with the log line "neither the subgraph nor the chain could list
   * hires" sitting right above it. Watched it happen once while verifying the
   * fix for the narrower version of itself.
   *
   * Nobody could say what this person is hired for and nobody could say what
   * they applied to. That is not an empty bench, it is no information.
   */
  const nothingCouldBeAsked =
    !answered && candidateIds.length > 0 && involvement.every((v) => !v.known);
  if (nothingCouldBeAsked) {
    /* UserFacingError, not Error: clientError() replaces a plain message with a
       generic "Could not open this commission", and the whole point of this
       throw is the sentence it carries. Somebody whose board has just emptied
       needs to read "your work is safe", not a logging notice. */
    throw new UserFacingError(
      "Could not reach the job index or the chain just now — nothing is lost, this is a read problem. It will retry on its own.",
    );
  }

  const out: WorkRow[] = [];
  for (const [i, escrowId] of candidateIds.entries()) {
    const { hired, applied } = involvement[i]!;
    if (!hired && !applied) continue;

    const t = byEscrow.get(escrowId);
    const esc = escrows.get(escrowId) as
      | { projectTitle?: string; totalAmount?: bigint; status?: number }
      | null
      | undefined;

    let title: string;
    let budget: number;
    if (t?.briefJson) {
      const brief = JSON.parse(t.briefJson);
      title = brief.title;
      budget = brief.budget;
    } else if (esc) {
      title = esc.projectTitle || `Job #${escrowId}`;
      budget = Number(esc.totalAmount ?? 0n) / 1e6; // USDC
    } else {
      continue; // nothing anywhere can describe it; a blank row helps nobody
    }

    /*
     * The escrow's own status decides a chain-hired job's state. Without a task
     * row there is no `t.status` to read, and defaulting to "hired" would keep
     * telling someone to send work on a job that had already been paid out.
     */
    const RELEASED = 3, DISPUTED = 4;
    const escState: WorkState | null = esc
      ? Number(esc.status) === RELEASED
        ? "completed"
        : Number(esc.status) === DISPUTED
          ? "disputed"
          : "hired"
      : null;

    /* The stage counts, read before anything reasons about them. */
    const p = progress.get(escrowId);
    /*
     * WHETHER WE READ THEM AT ALL — which zero cannot tell you.
     *
     * The milestone read has a catch that "leaves the row without a stage
     * summary". Everything below then read that absence as `?? 0`, and zero
     * stages is a meaningful number: it means nothing has been approved, so
     * there is something to send. A freelancer who had delivered every stage of
     * escrow 7 and been paid in full was shown "You were hired — send your
     * work" with the button enabled, because the RPC was rate-limited for one
     * request.
     *
     * Inviting somebody to redo finished work is worse than showing them
     * nothing. So the failure is carried as a fact rather than flattened into a
     * count.
     */
    const stagesKnown = p !== undefined;
    const awaitingReview = p?.awaiting ?? 0;
    const approved = p?.approved ?? 0;
    const needsRevision = p?.rejected ?? 0;
    const milestoneCount = p?.count ?? 0;
    /* Stages an arbiter closed — settled, but not accepted. */
    const arbitrated = p?.arbitrated ?? 0;
    /* Nothing further is owed on these, whichever way they went. */
    const settled = approved + arbitrated;

    /*
     * FINISHED MEANS EVERY STAGE IS APPROVED — not that the escrow says so.
     *
     * This read the escrow's own status for "Released", and an escrow whose
     * milestones are all approved and fully paid can still sit at "Submitted":
     * escrow 7 did, after a dispute was resolved. So a freelancer who had
     * delivered everything and been paid in full was still shown "in progress",
     * on a bench with nothing on it, above a row inviting them to send a next
     * stage that does not exist.
     *
     * The milestones are the work. When all of them are approved, the work is
     * done, whatever the escrow's own bookkeeping has caught up to.
     */
    /* Nothing left to do — which is not the same as every stage having been
       accepted, and must not be said as though it were. */
    const everyStageSettled = milestoneCount > 0 && settled >= milestoneCount;

    const state: WorkState = hired
      ? everyStageSettled
        ? "completed"
        : t
          ? t.status === "completed"
            ? "completed"
            : t.status === "disputed"
              ? "disputed"
              : "hired"
          : (escState ?? "hired")
      : t?.status === "posted"
        ? "applied"
        : "lost";

    const presentation: Record<WorkState, [string, string]> = {
      completed: ["✅", "Finished and paid"],
      disputed: ["⚖️", "With a human arbiter"],
      hired: ["🔨", "You were hired — send your work"],
      applied: ["⏳", "Applied, waiting on the agent"],
      lost: ["—", "Applied, but someone else was hired"],
    };
    let [icon, status] = presentation[state];

    /*
     * One delivery at a time.
     *
     * The board let somebody send stage two while stage one was still with the
     * reviewer, which is how a person ends up having delivered twice without a
     * single verdict. A rejected stage is different: that is precisely the
     * thing they are being asked to send again.
     */
    /* A stage an arbiter closed is not a stage still waiting for work. */
    const somethingToSend = milestoneCount === 0 || settled + awaitingReview < milestoneCount;
    const canSubmit =
      stagesKnown && state === "hired" && awaitingReview === 0 && somethingToSend;

    if (state === "hired" && !stagesKnown) {
      /* Say which part failed. "Send your work" here would be a request to do
         work that may already be done and paid for. */
      icon = "…";
      status = "Could not read this job's stages just now — trying again shortly";
    } else if (state === "hired" && needsRevision > 0 && awaitingReview === 0) {
      icon = "✏️";
      status = "Changes requested — revise and send it again";
    } else if (state === "hired" && awaitingReview > 0) {
      icon = "⏳";
      status =
        settled + awaitingReview >= milestoneCount && milestoneCount > 0
          ? awaitingReview === 1
            ? "Delivered — waiting on review"
            : `All ${milestoneCount} stages delivered — waiting on review`
          : `${awaitingReview} with the reviewer — the next stage opens once this one is decided`;
    } else if (state === "hired" && settled > 0 && milestoneCount > 0) {
      /* "Approved and paid" is the better sentence and stays the default; it is
         only wrong when an arbiter closed one of the stages it is counting. */
      status =
        arbitrated > 0
          ? `${approved} of ${milestoneCount} approved, ${arbitrated} settled by an arbiter — send the next stage`
          : `${approved} of ${milestoneCount} approved and paid — send the next stage`;
    } else if (state === "completed" && milestoneCount > 0) {
      /*
       * Say what happened, not just that it is over.
       *
       * "All 2 stage(s) approved and paid" was shown for a job whose second
       * stage an arbiter took off the freelancer and refunded to the client.
       * Somebody reading their own board should not have to go and check the
       * chain to find out they were not paid.
       */
      status = arbitrated > 0
        ? `${approved} of ${milestoneCount} approved · ${arbitrated} settled by an arbiter — you were paid $${(p?.earnedUsdc ?? 0).toFixed(2)} of $${((p?.earnedUsdc ?? 0) + (p?.lostUsdc ?? 0)).toFixed(2)}`
        : `All ${milestoneCount} stage(s) approved and paid`;
      if (arbitrated > 0) icon = "⚖️";
    }

    out.push({
      escrowId, title, budget, status, icon, state,
      awaitingReview, approved, needsRevision, milestoneCount, canSubmit,
      stagesKnown, arbitrated,
      earnedUsdc: p?.earnedUsdc ?? null,
      reviewer: reviewers.get(escrowId) ?? null,
    });
  }
  return out;
}

/**
 * SIGN A FILE UPLOAD AS THE WORKER, so a managed freelancer can attach work.
 *
 * WHY IT LIVES HERE
 *
 * The backend accepts an upload only against a signature from the escrow's
 * beneficiary — the right rule, and one a managed worker cannot satisfy from a
 * browser, because the whole point of a managed wallet is that they hold no
 * key. So the only route for them to send a screenshot or a mockup was the
 * Telegram bot, and on the web they could describe their work but never show
 * it. The agent has a vision reviewer; it was being handed prose about images
 * it could have looked at.
 *
 * The daemon holds their Circle wallet, so it signs on their instruction — the
 * same thing it already does to submit their work on-chain. Nothing about the
 * backend's rule changes: it still verifies a real signature from the real
 * beneficiary. Only the hand holding the pen is different.
 *
 * The signature covers the escrow, the milestone and a timestamp, so it
 * authorises one upload to one stage of one job and expires.
 */
export async function signUploadAuth(
  workerId: string,
  escrowId: string,
  milestoneIndex: number,
): Promise<{ address: string; message: string; signature: string; timestamp: string }> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) throw new UserFacingError("We do not know that account.");
  if (worker.mode !== "managed") {
    /* Somebody with their own keys signs for themselves; asking us to do it
       would be asking us to hold something we deliberately do not have. */
    throw new UserFacingError("Your own wallet signs this one — approve it in your wallet.");
  }

  const me = worker.walletAddress as `0x${string}`;

  /*
   * Only for a job that is actually theirs. Without this, a worker id would
   * authorise an upload against any escrow number somebody cared to type, and
   * escrow numbers are printed on every card.
   */
  const esc = (await atelier.getEscrow(BigInt(escrowId))) as { beneficiary?: string };
  if ((esc.beneficiary ?? "").toLowerCase() !== me.toLowerCase()) {
    throw new UserFacingError("That job is not yours to deliver to.");
  }

  const timestamp = String(Date.now());
  const message = [
    "Atelier file upload authorization",
    `Escrow: ${escrowId}`,
    `Milestone: ${milestoneIndex}`,
    `Wallet: ${me.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");

  /* Circle's API, not the EIP-1193 provider — that one does not implement
     personal_sign and answers "Method personal_sign is not supported". */
  if (!worker.walletId) throw new UserFacingError("That account has no managed wallet to sign with.");
  const signature = await signMessageAsWallet(worker.walletId, message);

  return { address: me, message, signature, timestamp };
}

/**
 * WHAT THE FREELANCER IS ABOUT TO DELIVER, AND WHAT IT WILL BE JUDGED BY.
 *
 * The delivery box asked "What did you deliver?" and said nothing about which
 * stage of the job that answer was going to be filed against, or what the stage
 * was supposed to contain. On a two-stage job the freelancer was typing into a
 * box that silently picked a milestone for them.
 *
 * Worse on an agent-run job, where an agent approves or rejects this submission
 * against written criteria. Being marked against a rubric is survivable; being
 * marked against one nobody showed you is not. The criteria already existed and
 * were already readable — they were just never put in front of the person whose
 * payment depended on meeting them.
 */
export async function deliveryTarget(escrowId: string): Promise<{
  escrowId: string;
  index: number;
  count: number;
  description: string;
  amountUsdc: number | null;
  criteria: string[];
  /** True when an agent, not the client, will review this. */
  agentReviewed: boolean;
  /** Why the last attempt at this stage was sent back, when it was. */
  previousFeedback: string | null;
  /**
   * How an arbiter split this stage, when one had to.
   *
   * The prose reason lives only in the resolver's own browser — it is written
   * to localStorage and the contract's DisputeResolved event does not carry it
   * — so the freelancer could never read it from anywhere. The SPLIT is
   * on-chain and is the part that actually decides anything, so that is what
   * gets shown rather than nothing at all.
   */
  disputeOutcome: {
    freelancerUsdc: number;
    clientUsdc: number;
    /** What the arbiter wrote, when they recorded it. */
    reason: string | null;
  } | null;
  /**
   * The reviewer's verdict on this stage, criterion by criterion.
   *
   * The reviewer has always produced this — which criteria passed, which did
   * not, and a note on each — and stored it. The freelancer, who is the one
   * person who has to act on it, was shown none of it. "Changes requested" tells
   * you that you failed; this tells you what to fix.
   */
  lastReview: {
    approved: boolean;
    score: number | null;
    criteriaResults: { criterion: string; passed: boolean; note: string }[];
  } | null;
}> {
  const index = await resolveMilestone(escrowId);

  let description = "";
  let amountUsdc: number | null = null;
  let count = 1;

  /*
   * The arbiter's split, taken off the milestone itself.
   *
   * `resolveDispute` writes the whole outcome into the struct —
   * resolvedAt, both amounts, and the reason — and this function was already
   * reading that struct for the stage description. It went looking for the same
   * numbers in the backend and then in a `DisputeResolved` LOG SCAN, both of
   * which fail exactly when the public RPC is under load. A plain read that is
   * already in flight cannot.
   */
  let onChainResolution:
    | { freelancerUsdc: number; clientUsdc: number; reason: string | null }
    | null = null;

  try {
    const onChain = (await atelier.getMilestones(BigInt(escrowId))) as readonly {
      amount: bigint;
      requirements: string;
      description: string;
      resolvedAt?: bigint;
      resolutionFreelancerAmount?: bigint;
      resolutionClientAmount?: bigint;
      resolutionReason?: string;
    }[];
    count = onChain.length || 1;
    const m = onChain[index];
    if (m) {
      // `requirements` is what the client agreed the stage must contain;
      // `description` is the shorter label. Prefer the one being judged.
      description = m.requirements || m.description || "";
      amountUsdc = Number(m.amount) / 1e6;

      if (Number(m.resolvedAt ?? 0n) > 0) {
        onChainResolution = {
          freelancerUsdc: Number(m.resolutionFreelancerAmount ?? 0n) / 1e6,
          clientUsdc: Number(m.resolutionClientAmount ?? 0n) / 1e6,
          reason: m.resolutionReason || null,
        };
      }
    }
  } catch {
    /* a chain hiccup must not stop someone delivering — the box still works */
  }

  /*
   * Fall back to generating them, rather than showing a freelancer nothing.
   *
   * criteriaFor only knows about jobs the daemon holds a brief for. A job hired
   * on-chain, or taken back off Autopilot, has no brief here — so the box that
   * exists to say "this is what you are judged on" said nothing at all on
   * exactly the jobs where the freelancer is most in the dark.
   *
   * previewCriteria answers from the escrow's own text and caches the result,
   * so this is one model call per job, not one per time somebody opens the box.
   */
  let { criteria } = handoverCriteriaFor(escrowId);
  if (criteria.length === 0) {
    try {
      criteria = (await previewCriteria(escrowId)).criteria;
    } catch {
      /* no criteria is a truthful answer; a failed read must not block delivery */
    }
  }

  /* Whether an agent reviews this decides how the criteria should be read: as
     the exact rubric a machine scores against, or as the client's notes. */
  let agentReviewed = false;
  try {
    agentReviewed = (await atelier.jobManagerOf(BigInt(escrowId))) !== null;
  } catch {
    /* unknown — say nothing rather than promise a reviewer we cannot confirm */
  }

  /*
   * What was wrong with the last attempt.
   *
   * The reviewer wrote it, it went into the decision log, and the person being
   * asked to do the work again never saw it. "Changes requested" without the
   * reason is just a rejection with extra steps — the feedback IS the useful
   * part, and it is already written down.
   */
  let previousFeedback: string | null = null;
  try {
    const rejections = store
      .listDecisions(300)
      .filter(
        (d: { task_id?: string; type?: string }) =>
          d.task_id === escrowId && (d.type === "work_rejected" || d.type === "revision_requested"),
      ) as { reasoning?: string; timestamp?: number }[];
    const latest = rejections.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
    previousFeedback = latest?.reasoning?.trim() || null;
  } catch {
    /* feedback is a bonus; never block a delivery over it */
  }

  let lastReview: {
    approved: boolean;
    score: number | null;
    criteriaResults: { criterion: string; passed: boolean; note: string }[];
  } | null = null;
  try {
    const history = store.listReviews<{
      approved?: boolean;
      score?: number;
      criteriaResults?: { criterion: string; passed: boolean; note: string }[];
    }>(escrowId, String(index));
    const latest = history[history.length - 1];
    if (latest && Array.isArray(latest.criteriaResults) && latest.criteriaResults.length > 0) {
      lastReview = {
        approved: latest.approved === true,
        score: typeof latest.score === "number" ? latest.score : null,
        criteriaResults: latest.criteriaResults,
      };
    }
  } catch {
    /* a verdict we cannot read is not worth failing a delivery over */
  }

  /*
   * THE RECORDED DECISION FIRST, THE LOG SCAN ONLY AS A FALLBACK.
   *
   * This read the split out of the DisputeResolved event through a windowed
   * getLogs scan — and that scan looks back a fixed number of chunks named
   * CHUNKS_PER_DAY, which is roughly 108,000 blocks and nothing like a day on
   * Arc. About an hour after escrow 7 was settled the amounts simply stopped
   * being found, so a freelancer's record of what had been decided about their
   * own payment quietly emptied out.
   *
   * The arbiter writes the split with their reasoning now, which makes one row
   * the whole decision and makes reading it a lookup rather than a search. The
   * scan stays for disputes settled before there was anywhere to write it, and
   * those are exactly the ones recent enough for it to still find.
   */
  let disputeOutcome:
    | { freelancerUsdc: number; clientUsdc: number; reason: string | null }
    | null = null;

  if (config.apiUrl) {
    try {
      const r = await fetch(`${config.apiUrl}/v1/disputes/resolution?escrow_id=${escrowId}`, {
        headers: config.apiSecret ? { authorization: `Bearer ${config.apiSecret}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const body = (await r.json()) as {
          resolutions?: {
            milestone_index: number;
            reason: string;
            freelancer_amount: number | null;
            client_amount: number | null;
          }[];
        };
        const mine = body.resolutions?.find((n) => Number(n.milestone_index) === index);
        if (mine && mine.freelancer_amount != null && mine.client_amount != null) {
          disputeOutcome = {
            freelancerUsdc: Number(mine.freelancer_amount),
            clientUsdc: Number(mine.client_amount),
            reason: mine.reason || null,
          };
        } else if (mine) {
          /* A note without amounts — recorded before the split was stored. Keep
             the words and let the chain supply the numbers below. */
          disputeOutcome = { freelancerUsdc: 0, clientUsdc: 0, reason: mine.reason || null };
        }
      }
    } catch {
      /* fall through to the chain */
    }
  }

  /* The struct is the most reliable source for the split, so it wins on the
     numbers. The backend is kept for the arbiter's written note, which is only
     stored there when they took the trouble to write one. */
  if (onChainResolution) {
    disputeOutcome = {
      freelancerUsdc: onChainResolution.freelancerUsdc,
      clientUsdc: onChainResolution.clientUsdc,
      reason: disputeOutcome?.reason ?? onChainResolution.reason,
    };
  }

  if (!disputeOutcome || (disputeOutcome.freelancerUsdc === 0 && disputeOutcome.clientUsdc === 0)) {
    try {
      const awards = await atelier.disputeAwards(BigInt(escrowId));
      const mine = awards.find((a) => Number(a.milestoneIndex) === index);
      if (mine) {
        /* disputeAwards already returns USDC, not base units. */
        disputeOutcome = {
          freelancerUsdc: mine.freelancerAmount,
          clientUsdc: mine.clientAmount,
          reason: disputeOutcome?.reason ?? null,
        };
      }
    } catch {
      /* a log scan that fails leaves the row without the split, not broken */
    }
  }

  return {
    escrowId, index, count, description, amountUsdc, criteria,
    agentReviewed, previousFeedback, lastReview, disputeOutcome,
  };
}

/**
 * Everything decided about one commission — who applied, what each scored, why.
 *
 * A tester wearing the client hat asked where they could see this. The answer
 * was "the public ledger", which was true and useless: nothing pointed them at
 * it. Transparency nobody can find isn't transparency.
 */
export function jobDetail(escrowId: string): {
  title: string;
  budget: number;
  status: string;
  criteria: string[];
  milestones: { description: string; amount: number }[];
  scores: { address: string; score: number; reasoning: string; hired: boolean; injection: boolean }[];
  outcome: string | null;
} | null {
  const task = store.listTasks(100).find((t) => t.escrowId === escrowId);
  if (!task?.briefJson) return null;
  const brief = JSON.parse(task.briefJson);
  const decisions = store.listDecisions(300).filter((d: { task_id?: string }) => d.task_id === escrowId);

  const hired = decisions.find((d: { type?: string }) => d.type === "applicant_accepted") as { target?: string } | undefined;
  const scores = decisions
    .filter((d: { type?: string }) => d.type === "application_scored")
    .map((d: { target?: string; score?: number; reasoning?: string }) => ({
      address: d.target ?? "",
      score: d.score ?? 0,
      reasoning: d.reasoning ?? "",
      hired: !!hired?.target && d.target?.toLowerCase() === hired.target.toLowerCase(),
      injection: (d.reasoning ?? "").includes("INJECTION"),
    }));

  const none = decisions.find((d: { type?: string }) => d.type === "no_suitable_applicant") as { reasoning?: string } | undefined;
  const outcome = hired?.target
    ? `Hired ${hired.target.slice(0, 10)}…`
    : none?.reasoning
      ? none.reasoning
      : task.status === "cancelled"
        ? "Deadline passed with no suitable applicant — the budget was returned in full."
        : null;

  return {
    title: brief.title,
    budget: brief.budget,
    status: task.status,
    criteria: brief.criteria ?? [],
    milestones: brief.milestones ?? [],
    scores,
    outcome,
  };
}

/** What they've earned. On Arc this is both their spendable balance and their gas. */
export async function balance(workerId: string): Promise<{ balance: string; address: string }> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) throw new UserFacingError("Unknown worker.");
  return { balance: await workerBalance(worker.walletAddress as `0x${string}`), address: worker.walletAddress };
}

/**
 * Check an address before we send money to it.
 *
 * There was no validation anywhere on either surface, so a mistyped destination
 * went all the way down to viem and came back as an encoding error — on the one
 * path where the user is moving their own earnings and most deserves a sentence
 * they can act on. We cannot catch a typo that is still a VALID address; we can
 * catch every string that could never have been one, and refuse the burn address.
 */
function requireAddress(value: string | undefined, what: string): `0x${string}` {
  const v = (value ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) {
    throw new UserFacingError(
      `That ${what} doesn't look like a wallet address — it should start with 0x and have 40 characters after it. Nothing was sent.`,
    );
  }
  if (/^0x0{40}$/.test(v)) {
    throw new UserFacingError(`That address is the burn address — anything sent there is gone forever. Nothing was sent.`);
  }
  return v as `0x${string}`;
}

/** The escape hatch. A withdrawal, not a key export — see workers/wallets.ts. */
export async function withdraw(workerId: string, destination: `0x${string}`, amountUsdc?: string) {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  if (worker.mode === "own") throw new UserFacingError("You're already using your own wallet — the money is in it.");
  if (!worker.walletAddress) throw new UserFacingError("No wallet on this account yet.");
  const to = requireAddress(destination, "destination address");
  if (amountUsdc !== undefined && !(Number(amountUsdc) > 0)) {
    throw new UserFacingError("The amount to withdraw has to be a positive number. Nothing was sent.");
  }
  return withdrawTo({ walletAddress: worker.walletAddress }, to, amountUsdc);
}

/** Graduation: keep the account, move to self-custody. Mode A is a ramp, not a trap. */
export async function switchToOwnWallet(workerId: string, addressInput: `0x${string}`) {
  const address = requireAddress(addressInput, "wallet address");
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  if (worker.mode === "managed" && worker.walletAddress) {
    // Sweep what they've earned before switching, or it's stranded in a wallet
    // they've just stopped using.
    try {
      await withdrawTo({ walletAddress: worker.walletAddress }, address);
    } catch {
      // nothing to sweep, or nothing worth the gas — the switch still stands
    }
  }
  store.setWorkerOwnWallet(workerId, address);
  return store.getWorker(workerId)!;
}

/**
 * POST A JOB FROM A MANAGED WALLET.
 *
 * The supply side of this marketplace was allowed to earn and nothing else. A
 * managed worker could apply, deliver, be paid and withdraw, and the moment
 * they wanted to hire somebody the app told them to connect a wallet — while
 * showing them their own address and balance in the header.
 *
 * That was a scope line dressed up as a rule. Nothing about custody forbids it:
 * this daemon already signs `applyToJob`, `startWork`, `submitMilestone` and
 * `withdraw` on a worker's instruction, and every one of those moves value or
 * commits them to work. Funding an escrow is the same act with a different
 * function selector.
 *
 * It also contradicted a decision already made elsewhere in the product — the
 * two dashboards were merged into one because "most people here hire someone
 * one week and take a job the next". A door that only opens outward makes that
 * sentence false for everybody who came through it.
 *
 * WHAT THIS IS CAREFUL ABOUT
 *
 * It spends somebody's custodial balance, so every check happens BEFORE the
 * first signature. A revert after an approve costs them gas and leaves them
 * with no job and no explanation, and they have no mempool to go and read.
 */
export async function commissionAsWorker(input: {
  workerId: string;
  instruction: string;
  title: string;
  budgetUsdc: number;
  durationDays: number;
  milestones: { description: string; amount: number }[];
  /**
   * Hand it to Autopilot once it is funded.
   *
   * A second transaction, because the escrow has to exist before it can have a
   * manager. Without it the job is funded and unmanaged — a manual job wearing
   * an Autopilot label, which is exactly the bug the browser flow had before
   * the hand-over was wired in there.
   */
  handToAutopilot?: boolean;
  /**
   * Put the escrow to work while it waits.
   *
   * DEFAULTED ON, NOT DONE SILENTLY.
   *
   * Opting in only ever moves in the poster's favour and the freelancer's: the
   * platform fee is waived, so they approve less today, and 60% of anything
   * earned goes to whoever does the work. That is a good default.
   *
   * It is still a parameter rather than a hard-coded true, because the contract
   * is emphatic that this is the depositor's call — "it is their capital at
   * risk, so the answer is theirs" — and it can never be changed once given.
   * A default the caller can see and override is a choice; a constant buried in
   * the daemon is Atelier answering a question that was addressed to them.
   */
  putToWork?: boolean;
}): Promise<{
  escrowId: string;
  txHash: string;
  taskId: string;
  handedOver: boolean;
  earning: boolean;
}> {
  const worker = store.getWorker(input.workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");

  /* Throws with the right sentence for somebody who brought their own keys —
     Atelier cannot sign for them, and should not pretend otherwise. */
  const signer = signerFor(worker);

  const milestones = input.milestones.filter((m) => m.description.trim() && m.amount > 0);
  if (milestones.length === 0) {
    throw new UserFacingError("A job needs at least one milestone with a description and an amount.");
  }

  /*
   * The milestones ARE the budget.
   *
   * createEscrow rejects a mismatch outright, and a revert here would be the
   * expensive way to learn it. Compared in integer base units, because 0.1 +
   * 0.2 is famously not 0.3 and a job funded to the cent should not fail on
   * the cent.
   */
  const toBase = (usdc: number) => BigInt(Math.round(usdc * 1e6));
  const milestoneAmounts = milestones.map((m) => toBase(m.amount));
  const total = milestoneAmounts.reduce((a, b) => a + b, 0n);
  const budget = toBase(input.budgetUsdc);
  if (total !== budget) {
    throw new UserFacingError(
      `The milestones add up to ${Number(total) / 1e6} USDC but the budget is ${input.budgetUsdc} USDC. They have to match.`,
    );
  }
  if (total <= 0n) throw new UserFacingError("The budget has to be more than zero.");

  /*
   * Can they actually afford it, fee included?
   *
   * The platform fee is charged on top of the budget, so somebody with exactly
   * their budget in the wallet cannot post — and the number they need to see is
   * the total, not the shortfall against a figure they never entered.
   */
  const { deposit, fee } = await atelier.quoteDeposit(total);
  const held = toBase(Number(await workerBalance(worker.walletAddress as `0x${string}`)));
  if (held < deposit) {
    throw new UserFacingError(
      `Posting this needs ${Number(deposit) / 1e6} USDC — ${input.budgetUsdc} for the work and ${Number(fee) / 1e6} in platform fee. Your wallet holds ${Number(held) / 1e6}.`,
    );
  }

  /* Signing costs gas, and a managed wallet is topped up rather than funded. */
  await dripGas(worker.walletAddress as `0x${string}`).catch(() => {
    /* Already has enough, or the faucet is empty — the write below will say so
       far more precisely than a guess here would. */
  });

  const taskId = crypto.randomUUID();
  store.insertTask({
    id: taskId,
    escrowId: null,
    instruction: input.instruction,
    /* "human" — this is a person hiring, and the decision log should not credit
       an agent for a commission a person wrote and paid for. */
    clientType: "human",
    status: "briefing",
    briefJson: null,
    clientAddress: worker.walletAddress,
  });

  try {
    const { escrowId, txHash } = await atelier.createEscrow(
      {
        totalAmount: total,
        durationDays: BigInt(Math.max(1, Math.round(input.durationDays))),
        milestoneAmounts,
        milestoneDescriptions: milestones.map((m) => m.description.trim()),
        projectTitle: input.title.trim().slice(0, 90),
        projectDescription: input.instruction.trim(),
      },
      signer,
    );

    store.updateTaskBrief(
      taskId,
      JSON.stringify({
        title: input.title.trim().slice(0, 90),
        budget: input.budgetUsdc,
        durationDays: input.durationDays,
        milestones,
      }),
    );
    store.updateTaskStatus(taskId, "posted", escrowId.toString());

    /*
     * The money is already safe at this point, so a failure here must not read
     * as a failure to post. The job exists and is funded; it simply is not
     * delegated yet, and the client can hand it over from My Jobs.
     */
    /*
     * The yield term, before the hand-over.
     *
     * Both are second transactions on an escrow that already holds the money,
     * so neither can turn a funded job into a failed one — but the ORDER
     * matters. The window closes when work starts, and the agent begins
     * collecting applications the moment it is manager, so the term is written
     * while nobody is relying on it yet.
     */
    let earning = false;
    if (input.putToWork !== false) {
      try {
        await atelier.setYieldOptIn(escrowId, true, signer);
        earning = true;
      } catch (err) {
        console.warn(
          "[commission] funded but not put to work:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    let handedOver = false;
    if (input.handToAutopilot) {
      try {
        await atelier.setJobManager(escrowId, config.circleWalletAddress as `0x${string}`, signer);
        handedOver = true;
      } catch (err) {
        console.warn(
          "[commission] funded but not handed to Autopilot:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { escrowId: escrowId.toString(), txHash, taskId, handedOver, earning };
  } catch (err) {
    /* Otherwise the row sits at "briefing" forever and the stats bar counts it
       as work in progress that nobody is doing. */
    store.updateTaskStatus(taskId, "failed");
    throw err;
  }
}
