// The Atelier contract overwrites `m.description` when the freelancer
// submits a milestone, so the original brief is unrecoverable from chain
// after submission. We snapshot it to localStorage the first time we see a
// milestone in NotStarted/pending state, then surface it alongside the
// submission response in the UI.

const KEY = (escrowId: string | number, index: number) =>
  `original_milestone_${escrowId}_${index}`;

export function cacheOriginalDescription(
  escrowId: string | number,
  index: number,
  description: string,
): void {
  if (typeof window === "undefined") return;
  if (!description || !description.trim()) return;
  try {
    const k = KEY(escrowId, index);
    if (!window.localStorage.getItem(k)) {
      window.localStorage.setItem(k, description);
    }
  } catch {
    /* localStorage unavailable / quota — non-fatal */
  }
}

export function getOriginalDescription(
  escrowId: string | number,
  index: number,
): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(KEY(escrowId, index)) ?? undefined;
  } catch {
    return undefined;
  }
}

// Sentinel — only set after a confirmed-good recovery (or capture-time
// snapshot). Failed recoveries leave it unset so the next page load retries.
const RECOVERY_KEY = (escrowId: string | number) =>
  `original_milestone_recovery_v2_${escrowId}`;

export function hasAttemptedRecovery(escrowId: string | number): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RECOVERY_KEY(escrowId)) !== null;
  } catch {
    return false;
  }
}

export function markRecoveryAttempted(escrowId: string | number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECOVERY_KEY(escrowId), "1");
  } catch {
    /* non-fatal */
  }
}

// Per-page in-memory dedupe so we don't fire two getLogs walks for the same
// escrow when an effect re-runs. Resets on full reload, which is fine — the
// localStorage cache catches the duplicate path on next render.
const inFlight = new Set<string>();

export function isRecoveryInFlight(escrowId: string | number): boolean {
  return inFlight.has(String(escrowId));
}

export function markRecoveryInFlight(escrowId: string | number): void {
  inFlight.add(String(escrowId));
}

export function clearRecoveryInFlight(escrowId: string | number): void {
  inFlight.delete(String(escrowId));
}

export function cacheOriginalDescriptions(
  escrowId: string | number,
  descriptions: string[],
): void {
  descriptions.forEach((d, i) => cacheOriginalDescription(escrowId, i, d));
}
