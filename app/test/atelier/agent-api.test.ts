import { describe, it, expect } from "vitest";
import {
  actionLabel,
  actorForDecisionType,
  applyEscalationLatch,
  toDecision,
  type DecisionRow,
} from "@/lib/atelier/agent-api";
import type { Decision } from "@/lib/atelier/actor";

const d = (id: string, by: Decision["by"], at: number): Decision => ({
  id,
  by,
  action: "x",
  at,
});

describe("actorForDecisionType", () => {
  it("attributes ordinary agent work to the agent", () => {
    expect(actorForDecisionType("brief_generated")).toBe("agent");
    expect(actorForDecisionType("application_scored")).toBe("agent");
    expect(actorForDecisionType("payment_released")).toBe("agent");
  });

  it("attributes escalation and dispute outcomes to a human", () => {
    expect(actorForDecisionType("escalated_to_human")).toBe("human");
    expect(actorForDecisionType("dispute_resolved")).toBe("human");
    expect(actorForDecisionType("arbiter_ruled")).toBe("human");
  });

  /**
   * An unrecognised type is the daemon having shipped a new event we have not
   * mapped yet. Defaulting it to "agent" is the safe direction: on an Autopilot
   * job the agent is who is acting unless we positively know otherwise, and
   * mislabelling agent work as a human's would overstate human oversight —
   * the more dangerous of the two errors.
   */
  it("defaults an unknown type to the agent", () => {
    expect(actorForDecisionType("some_future_event")).toBe("agent");
  });
});

describe("applyEscalationLatch", () => {
  it("leaves an un-escalated agent trail alone", () => {
    const out = applyEscalationLatch([
      d("1", "agent", 1),
      d("2", "agent", 2),
      d("3", "agent", 3),
    ]);
    expect(out.map((x) => x.by)).toEqual(["agent", "agent", "agent"]);
  });

  it("turns the trail human from the first human decision onward", () => {
    const out = applyEscalationLatch([
      d("1", "agent", 1),
      d("2", "human", 2),
      d("3", "agent", 3),
    ]);
    expect(out.map((x) => x.by)).toEqual(["agent", "human", "human"]);
  });

  /**
   * The case not designed for: a daemon that keeps emitting its own events
   * after escalation — which it does, because polling does not stop when an
   * arbiter is called in.
   *
   * Every one of those trailing events must read teal. If a later
   * `application_scored` came back amber, the log would show the agent
   * apparently taking the wheel back from a human arbiter, which is both false
   * and precisely the reassurance the client is looking for on this screen.
   */
  it("never lets the agent reclaim the trail after escalation", () => {
    const out = applyEscalationLatch([
      d("1", "agent", 1),
      d("2", "human", 2),
      d("3", "agent", 3),
      d("4", "agent", 4),
      d("5", "agent", 5),
    ]);
    expect(out.every((x, i) => (i >= 1 ? x.by === "human" : true))).toBe(true);
  });

  it("is idempotent — latching twice changes nothing", () => {
    const once = applyEscalationLatch([d("1", "agent", 1), d("2", "human", 2)]);
    expect(applyEscalationLatch(once)).toEqual(once);
  });

  it("handles an empty log", () => {
    expect(applyEscalationLatch([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [d("1", "agent", 1), d("2", "human", 2), d("3", "agent", 3)];
    applyEscalationLatch(input);
    expect(input[2].by).toBe("agent");
  });
});

describe("toDecision", () => {
  const row: DecisionRow = {
    id: "abc",
    task_id: "t1",
    type: "applicant_accepted",
    reasoning: "Strongest portfolio of the nineteen.",
    target: "0xabc",
    score: 91,
    timestamp: 1_757_000_000_000,
  };

  it("carries the agent's own reasoning through unedited", () => {
    expect(toDecision(row).rationale).toBe(
      "Strongest portfolio of the nineteen.",
    );
  });

  it("turns an empty reasoning into undefined rather than an empty paragraph", () => {
    expect(toDecision({ ...row, reasoning: "" }).rationale).toBeUndefined();
  });

  it("labels known types in prose and falls back readably", () => {
    expect(actionLabel("applicant_accepted")).toBe("Freelancer hired");
    expect(actionLabel("escalated_to_human")).toBe(
      "Escalated to a human arbiter",
    );
    expect(actionLabel("brand_new_event")).toBe("brand new event");
  });
});
