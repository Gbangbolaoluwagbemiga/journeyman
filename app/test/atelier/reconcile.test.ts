import { describe, it, expect } from "vitest";
import { reconcileMilestones, type AutopilotBrief } from "@/lib/atelier/agent-api";

/**
 * The escrow contract requires milestones to sum to the total EXACTLY. An LLM
 * does not know that, and occasionally returns a brief whose parts do not add
 * up — sometimes zeros, which produced a job worth nothing that a client was
 * one click from funding.
 *
 * These are the cases that reach createEscrow if this function is wrong.
 */

const brief = (budget: number, amounts: number[]): AutopilotBrief => ({
  title: "Logo",
  budget,
  durationDays: 3,
  criteria: [],
  deliverableFormat: "SVG",
  revisionRounds: 3,
  briefHash: "0x0",
  milestones: amounts.map((amount, i) => ({
    description: `Milestone ${i + 1}`,
    amount,
  })),
});

const sum = (b: AutopilotBrief) =>
  Math.round(b.milestones.reduce((t, m) => t + m.amount, 0) * 100) / 100;

describe("reconcileMilestones", () => {
  it("leaves a brief that already adds up alone", () => {
    const out = reconcileMilestones(brief(90, [30, 60]));
    expect(out.milestones.map((m) => m.amount)).toEqual([30, 60]);
  });

  /** The bug that shipped: every amount zero, so the escrow was worth nothing. */
  it("splits the budget evenly when every amount is zero", () => {
    const out = reconcileMilestones(brief(75, [0, 0]));
    expect(sum(out)).toBe(75);
    expect(out.milestones.every((m) => m.amount > 0)).toBe(true);
  });

  it("handles a single zero milestone, which is what the voiceover brief did", () => {
    const out = reconcileMilestones(brief(75, [0]));
    expect(out.milestones[0].amount).toBe(75);
  });

  it("scales proportionally when the parts do not match the whole", () => {
    // 1:2 split of a 90 budget, stated as 10 and 20.
    const out = reconcileMilestones(brief(90, [10, 20]));
    expect(out.milestones.map((m) => m.amount)).toEqual([30, 60]);
    expect(sum(out)).toBe(90);
  });

  it("scales down when the parts overshoot the budget", () => {
    const out = reconcileMilestones(brief(50, [100, 100]));
    expect(sum(out)).toBe(50);
  });

  /**
   * The one that matters most. Rounding to cents can leave the sum a cent short
   * or long, and a cent is enough for createEscrow to revert with
   * MilestoneSumMismatch. The remainder goes entirely on the last milestone.
   */
  it("always sums to the budget exactly, including awkward thirds", () => {
    for (const [budget, parts] of [
      [100, [1, 1, 1]],
      [10, [1, 1, 1]],
      [0.03, [1, 1, 1]],
      [99.99, [7, 11, 13]],
      [75, [1, 2]],
    ] as [number, number[]][]) {
      const out = reconcileMilestones(brief(budget, parts));
      expect(sum(out), `budget ${budget} split ${parts}`).toBe(budget);
    }
  });

  it("does not invent milestones for a zero-budget brief", () => {
    const out = reconcileMilestones(brief(0, [0, 0]));
    expect(sum(out)).toBe(0);
    expect(out.milestones).toHaveLength(2);
  });

  it("leaves descriptions untouched", () => {
    const out = reconcileMilestones(brief(90, [0, 0]));
    expect(out.milestones.map((m) => m.description)).toEqual([
      "Milestone 1",
      "Milestone 2",
    ]);
  });
});
