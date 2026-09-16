/**
 * ATELIER ↔ AGENT DAEMON.
 *
 * Autopilot is not a new brain. It is the agent daemon — already running 24/7,
 * already holding its keys server-side, already polling the subgraph to score
 * applicants and release payment — surfaced inside Atelier. This module is the
 * seam.
 *
 * The daemon is NOT being rewritten into Atelier's Express backend. It works,
 * it runs unattended, and a rewrite would be a lot of new code that produces
 * exactly the behaviour we already have. So Atelier talks to two backends: the
 * Express API for Atelier's own concerns, and this one for agent activity.
 *
 * Shapes here mirror `agent/daemon/src/store.ts` and the daemon's own types.
 * They are duplicated rather than imported because the daemon is a separate
 * deployable with its own release cycle — importing across that boundary would
 * couple two things that ship independently. When the daemon's shapes change,
 * `isDecisionRow` below starts rejecting rows and the log shows a gap, which is
 * the failure we want: visible, not silent.
 */

import type { Actor, Decision } from "./actor";

const BASE = (
  (import.meta.env.VITE_AGENT_API_URL as string | undefined) ?? ""
)
  .trim()
  .replace(/\/$/, "");

/** Whether Autopilot is reachable at all. False in a Atelier-only deploy. */
export const AUTOPILOT_CONFIGURED = BASE.length > 0;

/* ── Daemon wire shapes ──────────────────────────────────────────────────── */

export interface DecisionRow {
  id: string;
  task_id: string;
  type: string;
  reasoning: string;
  target: string | null;
  score: number | null;
  timestamp: number;
}

export interface TaskRow {
  id: string;
  escrowId: string | null;
  instruction: string;
  clientType: "agent" | "human";
  status: string;
  briefJson: string | null;
  createdAt: number;
}

/* ── The actor mapping — the heart of the visual language ────────────────── */

/**
 * Decision types that represent a HUMAN acting, even though they arrive on the
 * agent's own event stream.
 *
 * This list is short and it matters enormously. An Autopilot job reads amber
 * down its whole length; the moment one of these appears, the trail turns teal
 * and stays teal. That is not decoration — it is the record of a machine
 * handing control back to a person, which is the single most important thing a
 * client can see when they are deciding whether to trust the arrangement.
 *
 * `escalated_to_human` is the daemon's own name for hitting its revision limit
 * and calling in Atelier's dispute system. Everything downstream of it is a
 * person's judgement, so it must not be painted as the agent's.
 */
const HUMAN_DECISION_TYPES: ReadonlySet<string> = new Set([
  "escalated_to_human",
  "dispute_raised",
  "dispute_resolved",
  "arbiter_ruled",
  "client_overrode",
  "client_approved",
  "client_rejected",
]);

export function actorForDecisionType(type: string): Actor {
  return HUMAN_DECISION_TYPES.has(type) ? "human" : "agent";
}

/**
 * Once a job has been escalated, later agent chatter is no longer the thing in
 * charge — a human arbiter is. Painting a subsequent `application_scored` amber
 * would imply the agent took the wheel back, which it did not.
 *
 * So escalation is a latch: from the first human decision onward, the whole
 * remaining trail is teal.
 */
export function applyEscalationLatch(decisions: Decision[]): Decision[] {
  let escalated = false;
  return decisions.map((d) => {
    if (d.by === "human") escalated = true;
    return escalated ? { ...d, by: "human" as const } : d;
  });
}

/** Prose for the log's action line. Falls back to the raw type, never to "". */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  brief_generated: "Brief written",
  job_posted: "Job posted and escrow funded",
  applications_fetched: "Applications collected",
  application_scored: "Applicant scored",
  applicant_accepted: "Freelancer hired",
  no_suitable_applicant: "No applicant met the bar",
  portfolio_verified: "Portfolio checked",
  work_submitted: "Work submitted",
  work_approved: "Work approved",
  work_rejected: "Work rejected",
  revision_requested: "Revision requested",
  escalated_to_human: "Escalated to a human arbiter",
  payment_released: "Payment released",
  task_completed: "Job completed",
  error: "Something went wrong",
};

export function actionLabel(type: string): string {
  return ACTION_LABEL[type] ?? type.replace(/_/g, " ");
}

/** Narrow an unknown row from the wire. See the module note on why this exists. */
function isDecisionRow(v: unknown): v is DecisionRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.type === "string" &&
    typeof r.timestamp === "number"
  );
}

export function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    by: actorForDecisionType(row.type),
    action: actionLabel(row.type),
    rationale: row.reasoning || undefined,
    at: row.timestamp,
    // Carried through rather than dropped: these are the only record of why
    // one applicant was hired and another was not.
    score: typeof row.score === "number" ? row.score : undefined,
    subject: row.target || undefined,
  };
}

/* ── Fetching ────────────────────────────────────────────────────────────── */

export class AutopilotUnavailable extends Error {
  constructor(message = "Autopilot is not configured for this deployment.") {
    super(message);
    this.name = "AutopilotUnavailable";
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!AUTOPILOT_CONFIGURED) throw new AutopilotUnavailable();
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) {
    throw new Error(`Autopilot returned ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * The decision log, newest first from the daemon, returned oldest-first here
 * because a log is read downward and the escalation latch runs forward in time.
 *
 * Pass `taskId` to scope it to one job. The daemon keys decisions by task, not
 * by escrow, so callers who have an escrow id should use
 * `fetchDecisionsForEscrow` rather than filtering this themselves.
 */
export async function fetchDecisions(
  opts: { limit?: number; taskId?: string; signal?: AbortSignal } = {},
): Promise<Decision[]> {
  const limit = opts.limit ?? 100;
  const raw = await get<unknown>(`/api/decisions?limit=${limit}`, opts.signal);
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter(isDecisionRow);
  const scoped =
    opts.taskId === undefined
      ? rows
      : rows.filter((r) => r.task_id === opts.taskId);
  const decisions = scoped.map(toDecision).sort((a, b) => a.at - b.at);
  return applyEscalationLatch(decisions);
}

/**
 * One job's decision log, by escrow id.
 *
 * Two hops, because the daemon's two tables are keyed differently: tasks carry
 * the escrow id, decisions carry the task id. Doing the join here rather than at
 * each call site keeps the escalation latch correct — the latch must run over a
 * single job's decisions in time order, and a caller who filtered a
 * globally-latched list would inherit an escalation from somebody else's job.
 *
 * An escrow the daemon has never heard of returns an empty log, not an error:
 * that is the ordinary case for a manually-managed job.
 */
export async function fetchDecisionsForEscrow(
  escrowId: number | string,
  signal?: AbortSignal,
): Promise<Decision[]> {
  const wanted = String(escrowId);
  const tasks = await fetchTasks(signal);
  const task = tasks.find((t) => String(t.escrowId) === wanted);
  if (!task) return [];
  return fetchDecisions({ taskId: task.id, limit: 200, signal });
}

/** Every job the daemon is managing. Used to tell Autopilot jobs from manual. */
export interface AgentLimits {
  /** Largest budget the agent will accept for one job, in USDC. */
  maxJobBudgetUsdc: number;
  /** How long a job stays open for applications before it is judged. */
  applicationWindowMinutes: number;
}

/**
 * What the daemon will actually accept.
 *
 * Fetched rather than assumed: the cap lived only on the server, so the compose
 * page offered an example budget above it and the only way to learn the limit
 * was to be refused after a model call had already been spent.
 */
export async function fetchLimits(signal?: AbortSignal): Promise<AgentLimits> {
  return get<AgentLimits>("/api/limits", signal);
}

export interface WhitelistedToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  native: boolean;
}

/**
 * The tokens an escrow can actually be funded in.
 *
 * The contract's whitelist is a mapping, which cannot be listed, so the daemon
 * rebuilds it from logs and re-checks each one. One token is a statement, not a
 * question -- only ask the client to choose when the answer could differ.
 */
export async function fetchWhitelistedTokens(signal?: AbortSignal): Promise<WhitelistedToken[]> {
  return get<WhitelistedToken[]>("/api/tokens", signal);
}

export async function fetchTasks(signal?: AbortSignal): Promise<TaskRow[]> {
  const raw = await get<unknown>("/api/tasks", signal);
  return Array.isArray(raw) ? (raw as TaskRow[]) : [];
}

/**
 * The set of escrow IDs Autopilot manages.
 *
 * This is how Atelier knows a job is on Autopilot: the chain does not record it
 * — deliberately, since a freelancer must not be able to tell — so the daemon's
 * own task table is the only source of truth. Anything not in this set is
 * manual.
 */
export async function fetchManagedEscrowIds(
  signal?: AbortSignal,
): Promise<Set<string>> {
  const tasks = await fetchTasks(signal);
  return new Set(
    tasks
      .map((t) => t.escrowId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

/* ── The agent's own address ─────────────────────────────────────────────── */

export interface AutopilotWallet {
  address: `0x${string}`;
  balance: string;
  explorerUrl: string;
}

/**
 * The Circle wallet the daemon signs with — and therefore the address a client
 * must appoint as job manager for Autopilot to be able to do anything.
 *
 * Fetched rather than configured. A hardcoded VITE_ variable would be one
 * redeploy away from pointing at a wallet the daemon no longer uses, and the
 * failure mode is nasty: setJobManager would succeed, the client would see
 * "managed by Autopilot", and the agent would silently never be able to act —
 * a job that looks delegated and is actually abandoned.
 *
 * Asking the daemon means the answer is always the key it currently holds.
 */
export async function fetchAutopilotAddress(
  signal?: AbortSignal,
): Promise<AutopilotWallet> {
  const w = await get<Partial<AutopilotWallet>>("/api/wallet", signal);
  if (!w.address || !/^0x[a-fA-F0-9]{40}$/.test(w.address)) {
    throw new Error("Autopilot did not report a usable wallet address.");
  }
  return {
    address: w.address as `0x${string}`,
    balance: w.balance ?? "0",
    explorerUrl: w.explorerUrl ?? "",
  };
}

/* ── Brief preview ───────────────────────────────────────────────────────── */

export interface BriefMilestone {
  description: string;
  amount: number;
}

export interface AutopilotBrief {
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  deliverableFormat: string;
  revisionRounds: number;
  milestones: BriefMilestone[];
  briefHash: string;
  /** How long applications stay open before the agent judges them together. */
  applicationWindowMinutes?: number;
}

/**
 * Make the milestones add up to the budget.
 *
 * The generator is an LLM, and occasionally it returns milestones whose amounts
 * do not sum to the budget it just stated — sometimes zeros. That produced a
 * brief reading "Total $0.00" with a milestone worth nothing, and the escrow it
 * would have opened was worth nothing either.
 *
 * The escrow contract requires the milestones to sum to the total exactly, so
 * this is not cosmetic: an unreconciled brief either creates a worthless job or
 * reverts at createEscrow with MilestoneSumMismatch, and neither is a thing to
 * show someone who is about to fund it.
 *
 * Reconciled toward the BUDGET, because that is the number the client typed and
 * the one they will be charged. The split is the agent's suggestion; the total
 * is the client's instruction.
 */
export function reconcileMilestones(brief: AutopilotBrief): AutopilotBrief {
  const budget = Number(brief.budget) || 0;
  const milestones = (brief.milestones ?? []).map((m) => ({
    description: m.description,
    amount: Number(m.amount) || 0,
  }));

  if (budget <= 0 || milestones.length === 0) return { ...brief, milestones };

  const sum = milestones.reduce((t, m) => t + m.amount, 0);
  if (sum === budget) return { ...brief, milestones };

  // Nothing to scale proportionally — split the budget evenly instead.
  if (sum <= 0) {
    const each = Math.floor((budget / milestones.length) * 100) / 100;
    const scaled = milestones.map((m) => ({ ...m, amount: each }));
    scaled[scaled.length - 1].amount = round2(
      budget - each * (milestones.length - 1),
    );
    return { ...brief, milestones: scaled };
  }

  // Scale to fit, then put every rounding remainder on the LAST milestone so
  // the total is exact. Spreading the remainder would leave the sum a cent out,
  // which is precisely what the contract rejects.
  const scaled = milestones.map((m) => ({
    ...m,
    amount: round2((m.amount / sum) * budget),
  }));
  const scaledSum = scaled.reduce((t, m) => t + m.amount, 0);
  scaled[scaled.length - 1].amount = round2(
    scaled[scaled.length - 1].amount + (budget - scaledSum),
  );

  return { ...brief, milestones: scaled };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Ask Autopilot what it would post, without commissioning anything.
 *
 * The daemon's /api/instruct writes the brief and opens a funded escrow in one
 * call, which meant the only way to see the agent's proposal was to have
 * already paid for it. This runs the same generator and stops — no task, no
 * escrow, no treasury movement — so a client can read the milestones the agent
 * chose, and try another phrasing, before any money is involved.
 */
export async function previewBrief(
  instruction: string,
  signal?: AbortSignal,
): Promise<AutopilotBrief> {
  if (!AUTOPILOT_CONFIGURED) throw new AutopilotUnavailable();

  const res = await fetch(`${BASE}/api/brief/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
    signal,
  });

  const payload = (await res.json().catch(() => ({}))) as {
    brief?: AutopilotBrief;
    error?: string;
  };

  if (!res.ok) {
    // The daemon's own message is written for the client ("State a budget in
    // the instruction"), so it is better than anything generic we would add.
    throw new Error(payload.error ?? `Autopilot returned ${res.status}`);
  }
  if (!payload.brief || !Array.isArray(payload.brief.milestones)) {
    throw new Error("Autopilot returned a brief we could not read.");
  }
  // Reconciled before it is ever shown. See reconcileMilestones.
  return reconcileMilestones(payload.brief);
}

/** Where a brief waits while the client is sent to the funding wizard. */
export const AUTOPILOT_BRIEF_KEY = "atelier:autopilot-brief";

/* ── Handing a job to Autopilot: what it will judge by ───────────────────── */

export interface HandoverPreview {
  escrowId: string;
  title: string;
  /** The acceptance criteria Autopilot generated from what is on-chain. */
  criteria: string[];
  /**
   * Set when the job's title names work its description does not describe.
   *
   * The brief is always written from the description; the title is a label the
   * client typed. When the two genuinely disagree only the client can say which
   * they meant, so it is reported here rather than guessed at.
   */
  titleConflict?: string | null;
  applicationWindowMinutes: number;
  defaultWindowMinutes: number;
  minWindowMinutes: number;
  maxWindowMinutes: number;
  /** True once the client has already fixed these for this job. */
  approved: boolean;
}

/**
 * What Autopilot would work from, before the client signs it over.
 *
 * The daemon caches this per escrow on purpose: it is an LLM call behind a
 * dialog, and a client who closes and reopens it must be shown the same
 * standard they were reading a moment ago, not a freshly reworded one.
 */
export async function fetchHandoverPreview(
  escrowId: number,
  signal?: AbortSignal,
): Promise<HandoverPreview> {
  return get<HandoverPreview>(`/api/handover/preview?escrowId=${escrowId}`, signal);
}

/** The sentence the client signs. Must match the daemon's byte for byte. */
export function handoverMessage(
  address: string,
  escrowId: number,
  windowMinutes: number,
): string {
  return (
    `Atelier: hand job #${escrowId} to Autopilot\n` +
    `Review window: ${windowMinutes} minute(s)\n` +
    `Client: ${address.toLowerCase()}`
  );
}

/**
 * Fix the criteria and the review window for one job.
 *
 * Signed rather than open, for the reason cancellation is: escrow ids are
 * printed on every card, so an unsigned endpoint would let a stranger rewrite
 * the standard somebody else's job is judged by.
 */
export async function saveHandoverPrefs(opts: {
  escrowId: number;
  criteria: string[];
  applicationWindowMinutes: number;
  address: string;
  message: string;
  signature: string;
}): Promise<void> {
  if (!AUTOPILOT_CONFIGURED) throw new AutopilotUnavailable();

  const res = await fetch(`${BASE}/api/handover/prefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      escrowId: String(opts.escrowId),
      criteria: opts.criteria,
      applicationWindowMinutes: opts.applicationWindowMinutes,
      address: opts.address,
      message: opts.message,
      signature: opts.signature,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `Autopilot returned ${res.status}`);
}

export interface JobCriteria {
  criteria: string[];
  /** Where they came from — "none" means this job genuinely has none written. */
  source: "approved" | "brief" | "none";
  applicationWindowMinutes: number;
}

/**
 * What a freelancer is measured against on an agent-run job.
 *
 * Telegram printed these from the day the bot existed and the web card did not,
 * so the same commission read as two different jobs depending on where you
 * found it. This is the web's answer to the same question.
 */
export async function fetchJobCriteria(
  escrowId: number,
  signal?: AbortSignal,
): Promise<JobCriteria> {
  return get<JobCriteria>(`/api/jobs/criteria?escrowId=${escrowId}`, signal);
}

/* ── The assistant ───────────────────────────────────────────────────────── */

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AskViewer {
  role?: "client" | "freelancer" | "both" | null;
  hiring?: number;
  working?: number;
  page?: string | null;
}

export class AssistantBusy extends Error {}

/**
 * Ask Atelier a question.
 *
 * The viewer block is coarse on purpose — a role and a couple of counts. It is
 * what turns "how do milestones work" into an answer about the job you are
 * actually on, without ever handing a balance or an address to a language
 * model.
 */
export async function askAtelier(
  messages: AskTurn[],
  viewer?: AskViewer,
  signal?: AbortSignal,
): Promise<string> {
  if (!AUTOPILOT_CONFIGURED) throw new AutopilotUnavailable();

  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, viewer }),
    signal,
  });

  const payload = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
  if (res.status === 429) throw new AssistantBusy(payload.error ?? "Too many questions at once.");
  if (!res.ok) throw new Error(payload.error ?? `The assistant returned ${res.status}`);
  if (!payload.answer) throw new Error("The assistant had nothing to say.");
  return payload.answer;
}
