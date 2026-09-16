/**
 * HOW LONG IS LEFT — one answer, from the one field the chain actually stores.
 *
 * WHY THIS EXISTS
 *
 * An escrow has no createdAt and no duration on-chain. It has a deadline. Both
 * of the other two were synthesised by whichever loader ran, and the two
 * loaders did not agree:
 *
 *   the RPC path set createdAt to Date.now() — a placeholder, not a fact —
 *   and duration to the seconds REMAINING
 *
 *   the subgraph path set createdAt to the real creation time and duration to
 *   the seconds remaining as well
 *
 * So `createdAt + duration - now` came out as the time remaining on one path
 * and the time remaining MINUS the job's age on the other. The same job showed
 * a different number depending on which loader had run last, and adding a
 * background RPC refresh made it alternate between the two every fifteen
 * seconds. On top of that the card header rounded and the Days Left field
 * ceiled, so one card could say "9 days" and "10 days" about the same instant.
 *
 * The deadline is the only thing here that is true. Everything reads from it,
 * through this, and rounds the same way.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days remaining, never negative.
 *
 * Rounded UP, because a deadline 9.4 days away is a deadline somebody has to
 * meet on the tenth day, and telling them "9" quietly costs them a day. The
 * same choice has to be made in one place or the card contradicts itself.
 */
export function daysUntil(deadlineAtMs: number | undefined, now = Date.now()): number | null {
  if (!deadlineAtMs || deadlineAtMs <= 0) return null;
  return Math.max(0, Math.ceil((deadlineAtMs - now) / DAY_MS));
}

/** "10 days", "1 day", "today" — the sentence form, so it reads the same everywhere. */
export function describeDaysLeft(deadlineAtMs: number | undefined, now = Date.now()): string | null {
  const days = daysUntil(deadlineAtMs, now);
  if (days === null) return null;
  if (days === 0) return "due today";
  return days === 1 ? "1 day left" : `${days} days left`;
}
