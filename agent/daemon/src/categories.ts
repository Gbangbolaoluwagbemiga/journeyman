/**
 * What kind of work a job is. Mirrors app/src/lib/atelier/categories.ts.
 *
 * Duplicated rather than shared because the app and the daemon are separate
 * deployables with no build step between them, and a category vocabulary that
 * drifts is better than a package boundary invented for seven strings. If you
 * change one, change the other -- the marker format is the contract.
 *
 * WHY THIS IS NOT A CONTRACT FIELD
 *
 * A category changes nothing about how money moves, and the escrow is already
 * 415 bytes short of EIP-170. Spending an upgrade and a storage slot on a
 * browsing aid would be the wrong trade — so it is written into the job's
 * description as a machine-readable marker, and the subgraph lifts it into a
 * queryable field when it indexes the escrow.
 *
 * That keeps it filterable without touching the contract, and it means the
 * index does real work rather than mirroring storage.
 *
 * The marker is a single first line and is stripped before the description is
 * ever shown to anyone. A freelancer should never read "[category:design]".
 */

export const CATEGORIES = [
  { id: "design", label: "Design & brand", hint: "logos, identity, illustration, UI" },
  { id: "writing", label: "Writing", hint: "articles, copy, documentation" },
  { id: "video-audio", label: "Video & audio", hint: "editing, voiceover, motion" },
  { id: "development", label: "Development", hint: "web, contracts, integrations" },
  { id: "data", label: "Data & research", hint: "analysis, labelling, gathering" },
  { id: "marketing", label: "Marketing", hint: "social, growth, community" },
  { id: "other", label: "Something else", hint: "anything that does not fit above" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

const IDS = new Set<string>(CATEGORIES.map((c) => c.id));

/** The line written at the top of an escrow's description. */
export function categoryMarker(id: CategoryId): string {
  return `[category:${id}]`;
}

/**
 * Read the category back out of a description.
 *
 * Returns null rather than guessing. Every escrow created before this existed
 * has no marker, and mislabelling those would be worse than leaving them
 * uncategorised — a freelancer filtering by "design" should not be shown a job
 * that merely happens to mention a logo.
 */
export function categoryOf(description: string | undefined): CategoryId | null {
  if (!description) return null;
  const m = description.match(/\[category:([a-z-]+)\]/i);
  const id = m?.[1]?.toLowerCase();
  return id && IDS.has(id) ? (id as CategoryId) : null;
}

/** The description as a person should read it, with the marker removed. */
export function withoutMarker(description: string | undefined): string {
  if (!description) return "";
  return description.replace(/\[category:[a-z-]+\]\s*/i, "").trimStart();
}

export function categoryLabel(id: CategoryId | null): string | null {
  return CATEGORIES.find((c) => c.id === id)?.label ?? null;
}
