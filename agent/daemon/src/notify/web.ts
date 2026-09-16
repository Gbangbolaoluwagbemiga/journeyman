import { config } from "../config.js";
import type { AgentEvent } from "../agent/AgentClient.js";
import * as atelier from "../web3/atelier.js";

/**
 * THE OTHER HALF OF EVERY MESSAGE THE AGENT ALREADY SENDS.
 *
 * When the agent hires someone or releases a payment, it tells them on
 * Telegram. Web users were told nothing at all — not because anyone decided
 * that, but because of where notifications are written from: the browser of
 * whoever performed the action. That works when a person clicks Approve. When
 * the agent approves, there is no browser, so nobody is told.
 *
 * The effect was that Autopilot — the feature whose whole promise is that you
 * do not have to watch the job — was the one mode where you had to watch the
 * job, unless you happened to be on Telegram.
 *
 * WHY IT LISTENS TO EVENTS RATHER THAN LIVING AT THE CALL SITES
 *
 * The agent already emits an event for every consequential thing it does, and
 * the Telegram side is built on those. Hanging this off the same events means
 * the two channels cannot drift: a new event type is either handled for both or
 * neither, and there is no path where the bot says a freelancer was hired and
 * the web app disagrees.
 *
 * WHY IT NEVER THROWS
 *
 * A notification is a courtesy on top of an on-chain fact that has already
 * happened. If the API is down, the hire still stands and the money has still
 * moved; failing the agent's loop over an undelivered message would turn a
 * cosmetic outage into a stalled hire.
 */

/** The vocabulary the web app's notification centre renders. */
type WebNotificationType =
  | "milestone"
  | "dispute"
  | "escrow"
  | "application"
  | "message"
  | "rating";

interface WebNotification {
  to: string;
  type: WebNotificationType;
  title: string;
  message: string;
}

/**
 * Everyone who applied, straight off the chain.
 *
 * The chain rather than the index because this list decides who is told they
 * did not get a job — being missed off it is indistinguishable, to the person
 * missed, from the client never bothering. The index trails; the escrow does
 * not.
 */
async function applicantsOf(escrowId: string): Promise<string[]> {
  try {
    return [...(await atelier.getEscrowApplications(BigInt(escrowId)))];
  } catch {
    return [];
  }
}

/** Everyone who applied and did not get it, told once each. */
function losers(applicants: string[], winner: string | null): string[] {
  const won = winner?.toLowerCase();
  const seen = new Map<string, string>();
  for (const a of applicants) {
    const key = a?.toLowerCase();
    if (!key || key === won) continue;
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()];
}

/** Resolved from the chain, not the local task store. */
async function clientOf(escrowId: string): Promise<string | null> {
  try {
    const esc = await atelier.getEscrow(BigInt(escrowId));
    const depositor = (esc as { depositor?: string }).depositor;
    return depositor && depositor !== ZERO ? depositor : null;
  } catch {
    return null;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Who needs to hear about this, and what it says.
 *
 * Returns an empty list for events that are progress rather than news —
 * "scoring applicants", "fetching from the subgraph". Those belong in the live
 * feed for someone who is watching; pushing them as notifications trains people
 * to ignore the bell, and the bell is how they learn they were paid.
 */
export async function recipientsFor(event: AgentEvent): Promise<WebNotification[]> {
  const id = event.escrowId;
  if (!id) return [];

  const out: WebNotification[] = [];
  const worker = event.decision?.target;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  switch (event.type) {
    case "applicant_accepted": {
      if (worker) {
        out.push({
          to: worker,
          type: "application",
          title: "You got the job",
          message:
            "The budget is already locked in escrow and cannot be taken back — not even by the agent that hired you. Submit your work when it is ready.",
        });
      }
      const client = await clientOf(id);
      if (client) {
        out.push({
          to: client,
          type: "application",
          title: "Someone has been hired for your commission",
          message: worker
            ? `${short(worker)} scored highest against your brief. Every applicant's score and the reasoning is on the job.`
            : "The agent hired the strongest applicant against your brief.",
        });
      }

      /*
       * And everyone who did not get it.
       *
       * They applied, waited, and were told nothing — the job simply went quiet
       * on them forever. An answer you did not want is still better than
       * silence, and someone who knows they were not picked can go and apply
       * for the next one.
       */
      for (const who of losers(await applicantsOf(id), worker ?? null)) {
        if (client && who.toLowerCase() === client.toLowerCase()) continue;
        out.push({
          to: who,
          type: "application",
          title: "This job went to someone else",
          message:
            "The client has hired another freelancer. Thanks for applying — your application is closed, so you are free to take on other work.",
        });
      }
      break;
    }

    case "no_suitable_applicant": {
      const client = await clientOf(id);
      if (client) {
        out.push({
          to: client,
          type: "application",
          title: "Nobody cleared the bar yet",
          message:
            "No applicant met your brief's threshold, so the commission stays open and your money stays where it is.",
        });
      }

      /* Nobody was hired, which is still an outcome the people who applied are
         owed — and unlike a filled job, this one they can act on: the job is
         still open, so a better application can still win it. */
      for (const who of losers(await applicantsOf(id), null)) {
        if (client && who.toLowerCase() === client.toLowerCase()) continue;
        out.push({
          to: who,
          type: "application",
          title: "Nobody has been hired for this job yet",
          message:
            "No application met the brief's threshold this round. The job is still open, so a stronger application can still win it.",
        });
      }
      break;
    }

    /*
     * YOUR APPLICATION WAS READ, AND HERE IS WHAT IT SCORED.
     *
     * The score existed from the first day an agent hired anyone. It decided
     * who got the work, it was written into the decision log with its full
     * reasoning, and the person it was about was never told. They watched a job
     * they had applied to and saw nothing happen.
     *
     * Only ever to the applicant themselves. A comparative ranking is the
     * client's to see in full — telling every applicant what the others scored
     * would publish a judgement about a named person to their competitors.
     */
    case "application_scored": {
      if (!worker) break;
      const score = event.decision?.score;
      const reasoning = (event.decision?.reasoning ?? "").trim();

      out.push({
        to: worker,
        type: "application",
        title:
          typeof score === "number"
            ? `Your application scored ${score}/100`
            : "Your application has been read",
        /*
         * The reasoning, not just the number. A bare score tells someone they
         * lost without telling them anything they can use; the agent already
         * wrote why, and it is the only part of this that helps them write a
         * better application next time.
         */
        message: reasoning
          ? `${reasoning.slice(0, 380)}${reasoning.length > 380 ? "…" : ""}`
          : "The agent has read your application against the job's acceptance criteria.",
      });
      break;
    }

    /*
     * THE THING THE CLIENT PAID FOR HAS ARRIVED.
     *
     * This was filed under "progress is not news" and left silent, which was
     * wrong in the one direction that matters: the client is the person who has
     * to act. A submission sits there until somebody approves or rejects it,
     * and nothing told them it existed. They reloaded the page on a hunch and
     * found work that had been waiting.
     */
    case "work_submitted": {
      const client = await clientOf(id);
      if (client) {
        out.push({
          to: client,
          type: "milestone",
          title: "Your work has been delivered",
          message:
            "A milestone has been submitted and is waiting on your review. The money stays in escrow until you approve it.",
        });
      }
      break;
    }

    /*
     * The freelancer's money moved. This is the single most important thing the
     * bell has ever had to say, and it was the one it could not say at all when
     * the agent was the one approving.
     */
    case "payment_released": {
      const esc = await atelier.getEscrow(BigInt(id)).catch(() => null);
      const paid = (esc as { beneficiary?: string } | null)?.beneficiary;
      if (paid && paid !== ZERO) {
        out.push({
          to: paid,
          type: "milestone",
          title: "You have been paid",
          message: event.amountUsdc
            ? `$${event.amountUsdc} USDC has been released to you for an approved milestone.`
            : "A milestone was approved and the payment has been released to you.",
        });
      }
      break;
    }

    case "revision_requested":
    case "work_rejected": {
      const esc = await atelier.getEscrow(BigInt(id)).catch(() => null);
      const who = (esc as { beneficiary?: string } | null)?.beneficiary;
      if (who && who !== ZERO) {
        out.push({
          to: who,
          type: "milestone",
          title: "Changes requested on your work",
          message: event.message.slice(0, 400),
        });
      }
      break;
    }

    /* Both sides: the freelancer needs to stop waiting, the client needs to act. */
    case "escalated_to_human": {
      const esc = await atelier.getEscrow(BigInt(id)).catch(() => null);
      const who = (esc as { beneficiary?: string } | null)?.beneficiary;
      const client = await clientOf(id);
      if (who && who !== ZERO) {
        out.push({
          to: who,
          type: "dispute",
          title: "Your submission needs a human decision",
          message: "The agent has handed this milestone to the client rather than deciding it.",
        });
      }
      if (client) {
        out.push({
          to: client,
          type: "dispute",
          title: "A milestone needs your decision",
          message: "The agent could not settle this one against your brief and has passed it to you.",
        });
      }
      break;
    }

    default:
      return [];
  }

  return out;
}

/** Post one notification. Resolves either way; never rejects. */
async function post(n: WebNotification, escrowId: string): Promise<boolean> {
  if (!config.apiUrl) return false;
  try {
    const res = await fetch(`${config.apiUrl}/v1/notifications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiSecret ? { authorization: `Bearer ${config.apiSecret}` } : {}),
      },
      body: JSON.stringify({
        wallet_address: n.to,
        type: n.type,
        title: n.title,
        message: n.message,
        action_url: `${config.publicAppUrl}/jobs/${escrowId}`,
        data: { escrowId, source: "autopilot" },
      }),
      signal: AbortSignal.timeout(8000),
    });

    /*
     * Say when it fails. It used to just return false.
     *
     * A rejected POST here means somebody is not being told their work came
     * back, or that they were paid — and the only symptom was a quiet bell. It
     * cost two rounds of looking for a bug in the notification LOGIC, which was
     * correct both times; the delivery was what was broken.
     */
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[notify] ${n.type} to ${n.to.slice(0, 10)}… rejected: HTTP ${res.status} ${body.slice(0, 160)}`,
      );
    }
    return res.ok;
  } catch (err) {
    console.warn(
      `[notify] ${n.type} to ${n.to.slice(0, 10)}… failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Deliver everything this event owes to the web app.
 * @returns how many were accepted, for the caller's logs. Never throws.
 */
export async function notifyWeb(event: AgentEvent): Promise<number> {
  try {
    const list = await recipientsFor(event);
    if (list.length === 0) return 0;
    const results = await Promise.all(list.map((n) => post(n, event.escrowId!)));
    return results.filter(Boolean).length;
  } catch {
    return 0;
  }
}
