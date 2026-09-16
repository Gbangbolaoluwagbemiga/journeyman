/**
 * WHAT AUTOPILOT WILL JUDGE BY — shown before the client hands the job over,
 * and readable by the freelancer afterwards.
 *
 * WHY THIS EXISTS
 *
 * The agent already wrote acceptance criteria the moment a job was delegated:
 * adoptDelegated runs the escrow's title and description through the same brief
 * generator a fresh commission uses. The criteria were real, they decided who
 * got hired and whose work was approved, and nobody could see them.
 *
 * The client signed a hand-over dialog that admitted as much — "it may judge
 * against wording you have not seen" — and the freelancer applied to a card
 * that showed a title, a budget and nothing about the standard their work would
 * be measured against. On Telegram the bot printed criteria; on the web it did
 * not, which is the mismatch that made the two surfaces look like different
 * jobs.
 *
 * So: generate them BEFORE the signature, show them, let the client set the
 * review window in the same breath, and keep the approved version so adoption
 * uses exactly what was on screen rather than regenerating something new.
 */
import type { Abi } from "viem";
import atelierAbi from "../web3/AtelierABI.json" with { type: "json" };
import { config } from "../config.js";
import { getPublicClient } from "../web3/atelier.js";
import * as store from "../store.js";
import { generateBrief } from "./BriefGenerator.js";

const abi = atelierAbi as Abi;

/** How long a client may hold applications open, in minutes. */
export const MIN_WINDOW_MINUTES = 1;
export const MAX_WINDOW_MINUTES = 7 * 24 * 60; // a week

export interface HandoverPrefs {
  /** The criteria the client approved on screen. */
  criteria: string[];
  /** How long to leave applications open before scoring them together. */
  applicationWindowMinutes: number;
  /** When the client approved them. */
  approvedAt: number;
}

const prefsKey = (escrowId: string) => `handover_prefs:${escrowId}`;
const previewKey = (escrowId: string) => `handover_preview:${escrowId}`;

export function getPrefs(escrowId: string): HandoverPrefs | null {
  const raw = store.getPollerText(prefsKey(escrowId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HandoverPrefs;
  } catch {
    return null;
  }
}

export function savePrefs(escrowId: string, prefs: HandoverPrefs): void {
  store.setPollerText(prefsKey(escrowId), JSON.stringify(prefs));
}

/** The sentence a client signs to fix the criteria and window for one job. */
export function handoverMessage(address: string, escrowId: string, windowMinutes: number): string {
  return (
    `Atelier: hand job #${escrowId} to Autopilot\n` +
    `Review window: ${windowMinutes} minute(s)\n` +
    `Client: ${address.toLowerCase()}`
  );
}

export interface EscrowSummary {
  depositor: string;
  projectTitle: string;
  projectDescription: string;
}

export async function readEscrow(escrowId: string): Promise<EscrowSummary> {
  const client = getPublicClient();
  const esc = (await client.readContract({
    address: config.atelierAddress,
    abi,
    functionName: "getEscrow",
    args: [BigInt(escrowId)],
  })) as EscrowSummary;
  return esc;
}

/**
 * The criteria Autopilot would work from, generated from what is on-chain.
 *
 * Cached, because this is an LLM call sitting behind a dialog a client may open
 * more than once — and because the whole point is that the text they approved
 * is the text adoption later uses. Regenerating on each open would show a
 * different standard every time the dialog was reopened, which is precisely the
 * unpredictability this is meant to remove.
 */
export async function previewCriteria(escrowId: string): Promise<{
  criteria: string[];
  title: string;
  /** Set when the title names work the description does not describe. */
  titleConflict?: string;
}> {
  const esc = await readEscrow(escrowId);

  /*
   * A job already running is judged by the brief it was adopted with. Show that,
   * ahead of the cache and ahead of generating anything.
   *
   * Order matters here and it cost a wrong answer to learn. Checking the cache
   * first meant a preview taken BEFORE the job was adopted kept being served
   * after it, so the dialog and the freelancer's card quoted two different
   * standards for the same job — and the cached one was the one nobody was
   * being measured against.
   *
   * Escrow 7 showed how far apart the two can drift. Its title said "fireball"
   * and its description was a Discord support request; the generator read the
   * title once and the description the next time, so the same commission came
   * out as a vector illustration job and as an account-recovery job within the
   * hour. Whichever the agent adopted is the real one, because that is the one
   * it scores against.
   */
  const existing = criteriaFor(escrowId);
  if (existing.source !== "none") {
    return { criteria: existing.criteria, title: esc.projectTitle };
  }

  /*
   * Only now the cache, which exists so that reopening the dialog on a job that
   * has NOT been adopted yet shows the same criteria it showed a moment ago.
   * The generator is not deterministic; without this a client would be asked to
   * approve differently-worded criteria each time they looked.
   */
  const cached = store.getPollerText(previewKey(escrowId));
  if (cached) {
    try {
      return JSON.parse(cached) as { criteria: string[]; title: string };
    } catch {
      /* fall through and regenerate */
    }
  }
  const source = `${esc.projectTitle}\n\n${esc.projectDescription}`;
  const { brief } = await generateBrief(source);

  const out = {
    criteria: (brief.criteria ?? []).map((c) => String(c)).filter(Boolean),
    title: esc.projectTitle,
    /* Carried through so the client sees it before signing. A brief written
       from a description that contradicts its own title is not wrong, but the
       client is the only one who can say which they meant. */
    ...(brief.titleMatchesWork === false && brief.titleConflict
      ? { titleConflict: String(brief.titleConflict) }
      : {}),
  };
  store.setPollerText(previewKey(escrowId), JSON.stringify(out));
  return out;
}

/**
 * The criteria to show a freelancer looking at an agent-run job.
 *
 * Prefers what the client actually approved. Falls back to the adopted task's
 * brief, so a job delegated before any of this existed still answers rather
 * than looking like it has no standard at all.
 */
export function criteriaFor(escrowId: string): { criteria: string[]; source: "approved" | "brief" | "none" } {
  const prefs = getPrefs(escrowId);
  if (prefs && prefs.criteria.length > 0) return { criteria: prefs.criteria, source: "approved" };

  const task = store.listTasks(300).find((t) => t.escrowId === escrowId);
  if (task?.briefJson) {
    try {
      const brief = JSON.parse(task.briefJson) as { criteria?: unknown[] };
      const criteria = (brief.criteria ?? []).map((c) => String(c)).filter(Boolean);
      if (criteria.length > 0) return { criteria, source: "brief" };
    } catch {
      /* a malformed brief is not worth failing a read over */
    }
  }
  return { criteria: [], source: "none" };
}

/** Clamp a requested window to something the poller can actually honour. */
export function clampWindow(minutes: unknown): number | null {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_WINDOW_MINUTES || rounded > MAX_WINDOW_MINUTES) return null;
  return rounded;
}
