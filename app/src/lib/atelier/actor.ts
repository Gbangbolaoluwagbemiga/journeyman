/**
 * ATELIER — who acted, and who is allowed to know.
 *
 * The CSS in `styles/atelier.css` gives teal and amber a meaning (human /
 * agent). This module is the other half: it decides which of the two applies,
 * from data, so no component ever hardcodes a colour.
 *
 * There is one rule here that is a product rule, not a styling rule, and it is
 * the reason this file exists rather than a `className` ternary at each call
 * site:
 *
 *   A FREELANCER MUST NOT BE ABLE TO TELL WHETHER THEIR CLIENT IS A PERSON
 *   OR AN AGENT.
 *
 * That is already true on-chain — a human client and an Autopilot client emit
 * identical `applyToJob`/`acceptFreelancer` transactions to the same subgraph,
 * so the ledger does not distinguish them. It would be easy to leak the
 * distinction back in through the UI by rendering an amber "AI CLIENT" badge on
 * a job card in Browse Jobs, and that would quietly re-tier the marketplace:
 * workers would learn which queue pays faster, or which one they distrust, and
 * start self-selecting. One list, indistinguishable, is the product.
 *
 * So mode is not a property you may read wherever you happen to have a job. It
 * is readable only through `clientModeFor()`, which requires you to say whose
 * eyes you are rendering for.
 */

/** Who performed an action. The colour follows from this and nothing else. */
export type Actor = "human" | "agent";

/**
 * How a job is managed — that is, who does the labour of briefing, scoring
 * applicants, and reviewing deliverables.
 *
 * Note this is NOT "who the client is". A human client can run Autopilot; that
 * is the middle row of the product and the whole point of the merge. What
 * varies is the management, not the money: in both modes the escrow depositor
 * is the client, and dispute rights stay with the client.
 */
export type ClientMode = "manual" | "autopilot";

export const ACTOR_CLASS: Record<Actor, string> = {
  human: "actor-human",
  agent: "actor-agent",
};

/**
 * The class that switches a subtree to an actor's colour.
 * Prefer this over writing "actor-agent" inline — it keeps the mapping in one
 * place if the semantic ever grows a third actor.
 */
export function actorClass(actor: Actor): string {
  return ACTOR_CLASS[actor];
}

/** The actor implied by a management mode. Autopilot acts in amber. */
export function actorForMode(mode: ClientMode): Actor {
  return mode === "autopilot" ? "agent" : "human";
}

/**
 * Whose eyes we are rendering for. Passed explicitly so that the mode-hiding
 * rule above is enforced by the type system rather than by remembering it.
 */
export type Viewer =
  /** The client who funded this escrow — sees their own mode. */
  | { role: "client" }
  /** A worker browsing or working this job — must never see mode. */
  | { role: "freelancer" }
  /** An arbiter in a dispute — sees mode, because it is material to the case. */
  | { role: "arbiter" }
  /** Anonymous browsing, analytics, public pages. */
  | { role: "public" };

/**
 * Whether this job is on Autopilot, for a given viewer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS RULE WAS REVERSED DELIBERATELY, 2026-09-06.
 *
 * It used to return null for freelancers and the public, on the reasoning that
 * a worker who can tell an agent-run job from a human-run one will learn to
 * prefer one queue, and the single marketplace quietly becomes two tiers.
 *
 * The counter-argument won, and it is the stronger one: an agent is going to
 * read this person's work and decide whether they get paid. Concealing that is
 * not neutrality, it is withholding a material fact from the party with the
 * least power in the transaction. A freelancer choosing not to work for an
 * automated reviewer is making an informed choice, not a mistake to be designed
 * around.
 *
 * The tiering risk is real and is now handled honestly instead: the badge says
 * what the freelancer actually gains — review against fixed, published
 * criteria, within a known window — rather than "a machine owns you".
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function clientModeFor(
  mode: ClientMode,
  _viewer: Viewer,
): ClientMode | null {
  return mode;
}

/**
 * The actor to paint a job's chrome with.
 *
 * Now the same for every viewer, since mode is no longer concealed. The null
 * branch is kept because clientModeFor still returns an optional — a job whose
 * mode is genuinely unknown paints teal, which is the platform's ordinary
 * state.
 */
export function jobActorFor(mode: ClientMode, viewer: Viewer): Actor {
  const visible = clientModeFor(mode, viewer);
  return visible === null ? "human" : actorForMode(visible);
}

/** Human-readable labels. Used for chips and for screen readers. */
export const ACTOR_LABEL: Record<Actor, string> = {
  human: "Human",
  agent: "Autopilot",
};

export const MODE_LABEL: Record<ClientMode, string> = {
  manual: "Managed by you",
  autopilot: "Managed by Autopilot",
};

/**
 * A single entry in a job's decision log.
 *
 * `by` is the actor, and it is what colours the row. An Autopilot job is amber
 * down its whole length until a dispute pulls in a human arbiter, at which
 * point the trail turns teal and stays teal — the visual record of a machine
 * handing control back to a person.
 */
export interface Decision {
  id: string;
  /** Who made this call. Drives the colour. */
  by: Actor;
  /** Short label: "Brief written", "Shortlisted 3 of 19", "Milestone 2 approved". */
  action: string;
  /** The agent's or person's stated reasoning, shown in the log body. */
  rationale?: string;
  /** Unix ms. */
  at: number;
  /** On-chain transaction, when the decision moved money or state. */
  txHash?: string;
  /** USDC amount, when this decision paid someone. Rendered as the big figure. */
  amountUsdc?: string;
  /**
   * The agent's score out of 100, on a decision that judged somebody.
   *
   * The daemon has always sent this and the mapper dropped it, so the number
   * behind every hire existed on the wire and nowhere a person could read it —
   * a client could not see why one applicant was picked, and an applicant could
   * not see why they were not. Telegram told them; the web app did not.
   */
  score?: number;
  /** Who the decision was about — the applicant, on a scoring decision. */
  subject?: string;
}
