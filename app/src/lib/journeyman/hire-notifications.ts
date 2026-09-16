/**
 * TELLING THE PEOPLE WHO DIDN'T GET IT.
 *
 * When a client picks somebody, everyone else who applied is owed the same
 * answer the winner got. Silence is the one outcome that teaches an applicant
 * nothing: they cannot tell whether the client is still reading, whether the
 * job went to someone else, or whether it evaporated — so they keep the slot
 * open in their head and do not go and apply for the next one.
 *
 * This is the arithmetic of who that is, kept out of the click handler so it
 * can be checked. The mistakes it exists to prevent are all quiet ones:
 * congratulating the winner twice, messaging the client's own wallet, or
 * telling the same person twice because they applied from two devices.
 */

export interface Applicantish {
  freelancerAddress: string;
}

/**
 * Everyone who applied and did not get it.
 *
 * @param applications everyone who applied, as read from the chain
 * @param hired the address the client chose
 * @param client the client's own address, which must never be notified as a
 *        rejected applicant — a client can apply to their own board from a
 *        second wallet, and the self-dealing guard stops them being hired, not
 *        applying.
 */
export function unsuccessfulApplicants(
  applications: readonly Applicantish[] | null | undefined,
  hired: string,
  client?: string,
): string[] {
  const won = hired.toLowerCase();
  const me = client?.toLowerCase();

  const out = new Map<string, string>();
  for (const a of applications ?? []) {
    const addr = a?.freelancerAddress;
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (key === won || key === me) continue;
    // Keyed by lowercase so one person who applied twice is told once, but the
    // original casing is what gets sent — the API keys rows on the address it
    // is given.
    if (!out.has(key)) out.set(key, addr);
  }
  return [...out.values()];
}

/** What each of them is told. Plain, and never pretends there was no decision. */
export function positionFilledMessage(jobTitle: string): { title: string; message: string } {
  return {
    title: "This job went to someone else",
    message: `The client has hired another freelancer for "${jobTitle}". Thanks for applying — your application is closed, so you are free to take on other work.`,
  };
}
