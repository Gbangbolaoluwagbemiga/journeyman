/**
 * THE HUMAN FRONT DOOR.
 *
 * Atelier's demand side was always easy: an agent makes one HTTP call and x402
 * settles it. The supply side was behind a wall no actual freelancer would
 * climb — install MetaMask, add a network by chain id, source gas, find the
 * escrow, sign twice. Eight steps and three foreign concepts before earning a
 * first dollar. That is how a marketplace ends up with a working AI and zero
 * humans in it.
 *
 * This module is the other door. A person picks a name; the daemon provisions
 * them a real Circle MPC wallet, drips enough gas to sign with, and signs on
 * their instruction. They apply, deliver, and get paid without the word
 * "wallet" appearing anywhere.
 *
 * WHERE THE KEYS ARE, stated plainly because it is the trade-off being made:
 * the MPC wallet is controlled by the daemon, not by the person. That is
 * custody, and it is the price of removing the eight steps. It is why
 * `linkOwnWallet` exists — anyone who wants their own keys can switch, and
 * their history follows them.
 *
 * The browser never sees a private key, an entity secret, or a Circle wallet
 * id. Everything here is an identifier the daemon issued and can revoke.
 */

import { AUTOPILOT_CONFIGURED } from "./agent-api";

const BASE = (
  (import.meta.env.VITE_AGENT_API_URL as string | undefined) ?? ""
)
  .trim()
  .replace(/\/$/, "");

/** Whether the managed-worker layer is reachable at all. */
export const WORKER_DOOR_OPEN = AUTOPILOT_CONFIGURED;

/* ── Shapes, mirroring agent/daemon/src/workers/service.ts ───────────────── */

/** How this person's wallet is held. */
export type WalletMode = "managed" | "own";

export interface Worker {
  id: string;
  handle: string;
  address: `0x${string}`;
  mode: WalletMode;
  /** USDC, as a decimal string. Null when the balance read failed. */
  balance?: string | null;
  /**
   * The identity this account is signed in with — the Google address for a
   * managed wallet, null for someone using their own.
   *
   * On screen because two Google accounts can carry the same handle, and when
   * they do the dashboard is otherwise identical apart from a truncated hex
   * address. Signing in with the wrong one then looks exactly like the app
   * issuing a new wallet and losing the job the other account was hired for.
   */
  signedInAs?: string | null;
  /** True when this signed an existing person in rather than creating them. */
  returning?: boolean;
  /**
   * Their on-chain reputation, or null when it could not be read.
   *
   * A wallet user's dashboard has always shown this. A managed worker — the
   * half of the marketplace that most needs a track record, because they
   * arrived with no wallet and no history — had nowhere to build one.
   */
  rating?: { average: number; count: number } | null;
}

export interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  milestones: { description: string; amount: number }[];
  /** Epoch ms when applications close and the agent judges them together. */
  closesAt: number;
  /** Present only on the personalised board. */
  applied?: boolean;
}

export interface WorkItem {
  escrowId: string;
  title: string;
  budget: number;
  status: string;
  icon: string;
  state: string;
  /** Stages delivered and waiting on a verdict. */
  awaitingReview?: number;
  /** Stages already approved and paid. */
  approved?: number;
  milestoneCount?: number;
  /**
   * False when there is nothing left to send.
   *
   * The board offered "Send work" from the moment of hire until the job closed,
   * whatever had already been delivered — so a freelancer could file the next
   * stage without ever learning what happened to the last one.
   */
  canSubmit?: boolean;
  /**
   * Whether the stage counts on this row were actually read from the chain.
   *
   * False means they are placeholders, not figures — the daemon could not reach
   * the chain for this job. The board must not reason from them.
   */
  stagesKnown?: boolean;
  /**
   * Stages a human arbiter closed — settled, but not accepted.
   *
   * The contract sets a milestone to Approved whoever won a dispute, so this is
   * the only thing separating "they accepted your work" from "an arbiter took
   * this stage off you and refunded the client".
   */
  arbitrated?: number;
  /** USDC that actually reached this freelancer across the job. */
  earnedUsdc?: number | null;
  /** Stages sent back for changes. */
  needsRevision?: number;
  /**
   * Who decides on a submission — and therefore how long it should take.
   *
   * An agent answers in minutes; a client answers when they next open the tab.
   * From the freelancer's side both look identical: silence. Saying which is
   * the difference between waiting and worrying.
   */
  reviewer?: "agent" | "client" | null;
}

/* ── Session ─────────────────────────────────────────────────────────────── */

const SESSION_KEY = "atelier:worker-id";

/**
 * Who is using this browser.
 *
 * A worker id, not a wallet and not a password. It is deliberately low-stakes:
 * losing it loses access to a managed wallet's UI, which is why the balance
 * screen pushes people to withdraw to an address they control rather than
 * treating this as a bank.
 *
 * Wrapped because storage throws outright in some privacy modes, and a
 * marketplace that white-screens in a private window is worse than one that
 * forgets who you are.
 */
export function currentWorkerId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

/**
 * The signed-in worker's wallet address, for surfaces that need an identity
 * rather than a session.
 *
 * WHY THIS EXISTS
 *
 * The notification centre keys everything off a CONNECTED wallet. A managed
 * worker signs in with Google and never connects one, so the bell was
 * permanently empty for exactly the people who most need it — a freelancer is
 * not sitting on a dashboard waiting to find out their work was rejected. The
 * notification was written, stored and addressed to them; nothing could read it
 * back because nothing knew who they were.
 *
 * Kept beside the session id and cleared with it, so signing out stops the bell
 * as decisively as it stops everything else.
 */
const WORKER_ADDRESS_KEY = "atelier.worker.address";

/** Fires when the signed-in worker changes, so React can re-read it. */
export const WORKER_IDENTITY_EVENT = "atelier:worker-identity";

export function currentWorkerAddress(): string | null {
  try {
    return localStorage.getItem(WORKER_ADDRESS_KEY);
  } catch {
    return null;
  }
}

export function rememberWorkerAddress(address: string): void {
  try {
    localStorage.setItem(WORKER_ADDRESS_KEY, address);
    window.dispatchEvent(new Event(WORKER_IDENTITY_EVENT));
  } catch {
    /* Private mode — the bell falls back to empty, which is what it was. */
  }
}

export function rememberWorker(id: string): void {
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    /* Private mode. The session lasts as long as the tab, which still works. */
  }
}

export function forgetWorker(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(WORKER_ADDRESS_KEY);
    window.dispatchEvent(new Event(WORKER_IDENTITY_EVENT));
  } catch {
    /* ignore */
  }
}

/* ── Transport ───────────────────────────────────────────────────────────── */

export class WorkerDoorClosed extends Error {
  constructor(message = "The worker service is not configured for this deployment.") {
    super(message);
    this.name = "WorkerDoorClosed";
  }
}

async function call<T>(
  path: string,
  init?: RequestInit & { body?: string },
): Promise<T> {
  if (!WORKER_DOOR_OPEN) throw new WorkerDoorClosed();

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });

  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    // The daemon writes its errors for the person hitting them, so its message
    // beats anything generic added here.
    throw new Error(payload.error ?? `Worker service returned ${res.status}`);
  }
  return payload;
}

/* ── The door ────────────────────────────────────────────────────────────── */

/**
 * Become a freelancer.
 *
 * `handle` is the only required field. Everything a wallet normally demands —
 * a seed phrase, a network, gas — is the daemon's problem from here.
 *
 * `ownAddress` is for someone who already has a wallet and would rather keep
 * their keys; the daemon then signs nothing on their behalf.
 */
export async function join(input: {
  handle: string;
  /**
   * A Google ID token, required for a managed wallet. NOT an email.
   *
   * The daemon verifies this against Google's public keys and takes the email
   * out of the verified payload — the browser never gets to say who it is. An
   * earlier version accepted a plain email string, which meant knowing
   * somebody's address was enough to withdraw their money.
   */
  idToken?: string;
  skills?: string;
  ownAddress?: string;
}): Promise<Worker> {
  const worker = await call<Worker>("/api/worker/join", {
    method: "POST",
    body: JSON.stringify(input),
  });
  rememberWorker(worker.id);
  return worker;
}

export async function me(id: string): Promise<Worker> {
  return call<Worker>(`/api/worker/me?id=${encodeURIComponent(id)}`);
}

/** The open board. Pass a worker id to have it marked with what you applied to. */
export async function quests(workerId?: string | null): Promise<Quest[]> {
  const q = workerId
    ? `/api/worker/quests?id=${encodeURIComponent(workerId)}`
    : "/api/worker/quests";
  const rows = await call<Quest[]>(q);
  return Array.isArray(rows) ? rows : [];
}

export async function myWork(workerId: string): Promise<WorkItem[]> {
  const rows = await call<WorkItem[]>(
    `/api/worker/mine?id=${encodeURIComponent(workerId)}`,
  );
  return Array.isArray(rows) ? rows : [];
}

export async function apply(input: {
  workerId: string;
  escrowId: string;
  coverLetter: string;
  proposedTimelineDays?: number;
  portfolioUrl?: string;
}): Promise<{ txHash?: string }> {
  return call("/api/worker/apply", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface DeliveryTarget {
  escrowId: string;
  /** Zero-based index of the stage this delivery will be filed against. */
  index: number;
  count: number;
  description: string;
  amountUsdc: number | null;
  criteria: string[];
  /** True when an agent, not the client, reviews this submission. */
  agentReviewed: boolean;
  /** Why the last attempt at this stage was sent back, when it was. */
  previousFeedback?: string | null;
  /**
   * The reviewer's verdict, criterion by criterion.
   *
   * Always produced and always stored; never shown to the one person who has
   * to act on it. "Changes requested" says you failed. This says what to fix.
   */
  lastReview?: {
    approved: boolean;
    score: number | null;
    criteriaResults: { criterion: string; passed: boolean; note: string }[];
  } | null;
  /**
   * How an arbiter split this stage, when one had to.
   *
   * The written reason lives only in the resolver's own browser, so it is not
   * something the other side can ever be shown. The split is on-chain and is
   * the part that decides anything, so that is what gets shown.
   */
  disputeOutcome?: {
    freelancerUsdc: number;
    clientUsdc: number;
    /** What the arbiter wrote, when they recorded it. */
    reason?: string | null;
  } | null;
}

/**
 * Which stage a freelancer is about to deliver, and the rubric it faces.
 *
 * The delivery box asked "What did you deliver?" and said nothing about which
 * milestone that answer went to — on a two-stage job it silently picked one —
 * or what the stage was meant to contain. On an agent-run job a machine then
 * approved or rejected it against criteria the freelancer had never seen.
 */
export async function deliveryTarget(escrowId: string): Promise<DeliveryTarget> {
  return call<DeliveryTarget>(
    `/api/worker/delivery?escrowId=${encodeURIComponent(escrowId)}`,
  );
}

export async function submit(input: {
  workerId: string;
  escrowId: string;
  /* Omit to deliver the stage that actually needs work. The daemon resolves it
     — hard-coding 0 sent a second milestone's delivery to the first one. */
  milestoneIndex?: number;
  description: string;
}): Promise<{ txHash?: string }> {
  return call("/api/worker/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Move earnings to an address the person actually controls.
 *
 * The important button in the whole flow. A managed wallet is a convenience for
 * getting started, not somewhere to leave money — the UI should keep saying so.
 */
export async function withdraw(input: {
  workerId: string;
  destination: string;
  amountUsdc: string;
}): Promise<{ txHash?: string }> {
  return call("/api/worker/withdraw", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Post a job, funded from the managed wallet.
 *
 * The other side of the table for somebody with no private key. Their Circle
 * wallet is the depositor, so the escrow answers to them — not to Atelier and
 * not to the agent, which is the same rule a wallet client gets.
 *
 * `handedOver` is reported separately because the hand-over is a second
 * transaction and can fail on its own, after the money is already safe. A job
 * that is funded but not delegated is a real state, and calling it a failure
 * would send somebody looking for a refund on an escrow that exists.
 */
export async function commission(input: {
  workerId: string;
  instruction: string;
  title: string;
  budgetUsdc: number;
  durationDays: number;
  milestones: { description: string; amount: number }[];
  handToAutopilot?: boolean;
  /** Put the escrow to work while it waits. Defaults on. */
  putToWork?: boolean;
}): Promise<{
  escrowId: string;
  txHash: string;
  taskId: string;
  handedOver: boolean;
  earning: boolean;
}> {
  return call("/api/worker/commission", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Swap a managed wallet for one whose keys the person holds. History follows. */
export async function linkOwnWallet(input: {
  workerId: string;
  address: string;
}): Promise<Worker> {
  return call<Worker>("/api/worker/switch-wallet", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Minutes until applications close, floored at zero. */
export function minutesUntilClose(quest: Quest, now = Date.now()): number {
  return Math.max(0, Math.ceil((quest.closesAt - now) / 60_000));
}

/**
 * Get back into an account you already have.
 *
 * Takes a Google ID token, like joining does. The previous version took an
 * email in a query string and handed back a worker id — which is a withdrawal
 * credential — so it gave away other people's wallets to anyone who knew their
 * address. Replaced rather than patched: the shape of it was the problem.
 */
export async function recover(idToken: string): Promise<Worker> {
  const worker = await call<Worker>("/api/worker/recover", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  rememberWorker(worker.id);
  return worker;
}

/**
 * An authorisation to attach one file to one milestone, signed by the daemon
 * with the worker's own managed wallet.
 *
 * The freelancer holds no key, so they cannot produce this themselves — and the
 * backend is right to demand it. Without this, the only way for a managed
 * worker to send a screenshot was the Telegram bot: on the web they could
 * describe their work but never show it, while the agent reviewing it has a
 * vision model and was being handed prose about images it could have looked at.
 */
export async function uploadAuth(input: {
  workerId: string;
  escrowId: string;
  milestoneIndex: number;
}): Promise<{ address: string; message: string; signature: string; timestamp: string }> {
  return call("/api/worker/upload-auth", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
