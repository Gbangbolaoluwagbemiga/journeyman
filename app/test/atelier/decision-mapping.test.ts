import { describe, it, expect } from "vitest";
import { toDecision, type DecisionRow } from "@/lib/atelier/agent-api";

/**
 * THE SEAM WHERE THE SCORES WERE LOST.
 *
 * The daemon records a score and a subject for every applicant it reads. This
 * function turns its row into the shape the UI renders, and for months it
 * dropped both — so the number behind every hire travelled across the wire and
 * was thrown away one function before anyone could see it.
 *
 * Nothing caught it. Every component test mocks `useDecisions`, so they all
 * assert against a hand-built Decision and never once exercise the mapping that
 * produces a real one. That blind spot is the reason this file exists: it is
 * the only place the wire format meets the render format.
 */

function row(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "d1",
    task_id: "delegated-7",
    type: "application_scored",
    reasoning: "Strong portfolio, timeline is tight.",
    target: "0xfC3642978a1a46ff751ee259906E07ddD7d43Bd1",
    score: 72,
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe("what survives the mapping", () => {
  it("keeps the score", () => {
    expect(toDecision(row()).score).toBe(72);
  });

  it("keeps who the decision was about", () => {
    expect(toDecision(row()).subject).toBe("0xfC3642978a1a46ff751ee259906E07ddD7d43Bd1");
  });

  it("keeps the reasoning, which is what makes a score checkable", () => {
    expect(toDecision(row()).rationale).toMatch(/timeline is tight/);
  });

  it("keeps the timestamp, since a log is read in order", () => {
    expect(toDecision(row()).at).toBe(1_700_000_000_000);
  });
});

describe("decisions that judged nobody", () => {
  /* Most decisions are not scores — a payment, a brief, an escalation. Those
     must not arrive carrying a score of zero, which would render as a
     rejection. */
  it("leaves the score undefined rather than zero", () => {
    const d = toDecision(row({ type: "payment_released", score: null, target: null }));
    expect(d.score).toBeUndefined();
    expect(d.subject).toBeUndefined();
  });

  /* A genuine zero is a real verdict — an injection attempt scores 0-5 — and
     must not be confused with "no score". */
  it("keeps a score of zero, which is a verdict and not an absence", () => {
    expect(toDecision(row({ score: 0 })).score).toBe(0);
  });

  it("treats an empty target as no subject", () => {
    expect(toDecision(row({ target: "" })).subject).toBeUndefined();
  });
});
