/**
 * Turning wallet and contract errors into something a person can act on.
 *
 * viem throws magnificently detailed errors. Rendered straight into a toast they
 * look like this:
 *
 *   User rejected the request. Request Arguments: chain: Arc EVM Testnet (id:
 *   5042002) from: 0x3Be7… to: 0x370e… data: 0x0735ab8600000000000000000000…
 *   Contract Call: address: 0x370e… Version: viem@2.49.0
 *
 * Every word of that is true and none of it is useful to the person who just
 * pressed a button. Worse, the actual sentence — "you cancelled it" — is buried
 * at the front of a wall the eye slides straight off.
 *
 * So: recognise the handful of failures that actually happen, say what happened
 * and what to do about it, and keep the raw text available for the console
 * rather than the screen.
 *
 * The contract's custom errors matter as much as the wallet's. `Unauthorized()`
 * in a toast tells a client nothing; "only the client who funded this escrow can
 * do that" tells them why the button did not work.
 */

/** Contract custom errors, in the words of the person hitting them. */
const CONTRACT_ERRORS: Readonly<Record<string, string>> = {
  Unauthorized:
    "Only the client who funded this escrow can do that.",
  ManagerCannotBeBeneficiary:
    "Autopilot cannot manage a job it is also hired for — that is the guard that stops it paying itself.",
  ManagerCannotSelfHire:
    "Autopilot cannot hire itself for a job it manages.",
  NoManagerSet:
    "This job is not being managed by Autopilot, so there is nothing to take back.",
  EscrowNotActive:
    "This escrow is not active — it may be disputed, cancelled or already finished.",
  MilestoneNotSubmitted:
    "That milestone has not been submitted yet, so there is nothing to approve.",
  DeadlineNotPassed:
    "The deadline has not passed yet.",
  TokenNotWhitelisted:
    "That token is not accepted for escrow on this contract.",
  MilestoneSumMismatch:
    "The milestone amounts have to add up to the total budget.",
  InvalidAmount: "That amount is not valid.",
  InvalidAddress: "That address is not valid.",
  InvalidConfig: "Some of those settings are not valid together.",
  AlreadyApplied: "You have already applied to this job.",
  NotAnOpenJob: "This job is not open for applications.",
  FreelancerNotApplied: "That freelancer has not applied to this job.",
  CannotCancelAssignedJob:
    "This job already has a freelancer, so it cannot be cancelled — raise a dispute instead.",
  JobAlreadyAssigned: "This job already has a freelancer.",
  AlreadyRated: "You have already left a rating for this job.",
  InvalidRating: "A rating has to be between 1 and 5.",
  EscrowNotReleased: "You can only rate a job once it has been fully released.",
  NotParticipant: "Only the client or the freelancer on this job can do that.",
  ExtensionTooShort: "Extend the deadline by at least one day.",
  EnforcedPause:
    "The platform is paused for maintenance — nothing can move right now.",
  OwnableUnauthorizedAccount:
    "Only the contract owner can do that.",
};

/**
 * Patterns matched against the raw message, in order. First hit wins, so the
 * specific cases go above the general ones.
 */
const PATTERNS: readonly [RegExp, string][] = [
  [
    /user rejected|user denied|rejected the request|action_rejected|4001/i,
    "You cancelled the transaction in your wallet.",
  ],
  [
    /insufficient funds|exceeds balance|InsufficientBalance/i,
    "Not enough balance to cover this transaction and its gas.",
  ],
  [
    /insufficient allowance|ERC20InsufficientAllowance/i,
    "This contract is not approved to move that token yet.",
  ],
  [
    /nonce too low|already known|replacement transaction underpriced/i,
    "A transaction from this wallet is already pending — wait for it to confirm, then try again.",
  ],
  [
    /chain mismatch|does not match the target chain|ChainMismatchError|wrong network/i,
    "Your wallet is on the wrong network. Switch it to Arc and try again.",
  ],
  [
    /timed out|timeout|took too long/i,
    "The network took too long to respond. The transaction may still go through — check your wallet before retrying.",
  ],
  [
    /failed to fetch|network ?error|fetch failed|ECONNREFUSED/i,
    "Could not reach the network. Check your connection and try again.",
  ],
  [
    /gas required exceeds|out of gas|intrinsic gas too low/i,
    "This transaction needs more gas than the estimate allowed.",
  ],
];

function rawTextOf(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    // viem stacks the useful part in `shortMessage`/`details`; fall back to the
    // whole message, which is what produces the wall of text.
    const e = error as Error & { shortMessage?: string; details?: string; cause?: unknown };
    return [e.shortMessage, e.details, e.message, rawTextOf(e.cause)]
      .filter(Boolean)
      .join(" | ");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * A sentence to put in front of a person.
 *
 * Always returns something — an unrecognised failure gets its first clause
 * rather than the whole dump, because a truncated real message still beats
 * "Something went wrong", and the console keeps the rest.
 */
export function humanizeError(error: unknown): string {
  const raw = rawTextOf(error);
  if (!raw) return "Something went wrong. Please try again.";

  for (const [pattern, message] of PATTERNS) {
    if (pattern.test(raw)) return message;
  }

  // Contract custom errors arrive as e.g. `... reverted with the following
  // custom error: Unauthorized()` or `Error: Unauthorized()`.
  for (const [name, message] of Object.entries(CONTRACT_ERRORS)) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(raw)) return message;
  }

  // A plain revert string the contract author wrote for a human.
  const reverted = raw.match(/reverted with reason string ['"]([^'"]+)['"]/i);
  if (reverted) return reverted[1];

  /* Unrecognised. Take the first sentence and stop at the point where viem
     starts listing request arguments — that boundary is where the message stops
     being about the user and starts being about the RPC call. */
  const firstLine = raw
    .split(/Request Arguments:|Contract Call:|Version: viem|\n/)[0]
    .trim();
  return firstLine.length > 0 && firstLine.length <= 200
    ? firstLine
    : "That transaction could not be completed. Check the console for details.";
}

/**
 * Toast-shaped: a title that says which action failed, and a body that says why.
 * Logs the original, so nothing is actually lost.
 */
export function toastError(title: string, error: unknown) {
  console.error(`${title}:`, error);
  return {
    variant: "destructive" as const,
    title,
    description: humanizeError(error),
  };
}
