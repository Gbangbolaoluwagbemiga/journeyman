import { describe, it, expect } from "vitest";
import {
  actorClass,
  actorForMode,
  clientModeFor,
  jobActorFor,
  type Viewer,
} from "@/lib/atelier/actor";

/**
 * These tests used to guard the opposite rule.
 *
 * The original design concealed client mode from freelancers, so that a worker
 * could not learn to prefer one queue and split the marketplace into two tiers.
 * The tests here enforced that, including the subtle part — that concealment by
 * omission is not concealment, since hiding only the agent jobs makes them
 * identifiable by elimination.
 *
 * That decision was reversed on 2026-09-06, and the tests are reversed with it
 * rather than deleted. An agent is going to read this person's work and decide
 * whether they get paid; withholding that is not neutrality, it is keeping a
 * material fact from the party with the least power in the deal. A freelancer
 * who would rather not work for an automated reviewer is making an informed
 * choice, not a mistake to design around.
 *
 * What is still tested is that the answer is CONSISTENT. Whatever we tell one
 * viewer we tell all of them — a rule that leaked for some roles and not others
 * would be the worst of both designs.
 */

const CLIENT: Viewer = { role: "client" };
const FREELANCER: Viewer = { role: "freelancer" };
const ARBITER: Viewer = { role: "arbiter" };
const PUBLIC: Viewer = { role: "public" };

describe("clientModeFor — everyone sees how a job is managed", () => {
  it("tells the client their own mode", () => {
    expect(clientModeFor("autopilot", CLIENT)).toBe("autopilot");
    expect(clientModeFor("manual", CLIENT)).toBe("manual");
  });

  it("tells an arbiter, because mode is material to a dispute", () => {
    expect(clientModeFor("autopilot", ARBITER)).toBe("autopilot");
  });

  /**
   * The reversal, asserted directly: a freelancer is told that an agent will
   * review their work, before they spend two days on it.
   */
  it("tells a freelancer, so they can decide before they work", () => {
    expect(clientModeFor("autopilot", FREELANCER)).toBe("autopilot");
    expect(clientModeFor("manual", FREELANCER)).toBe("manual");
  });

  it("tells the public, so a job card can carry the badge", () => {
    expect(clientModeFor("autopilot", PUBLIC)).toBe("autopilot");
  });

  /**
   * Consistency is what is left to protect. A rule that disclosed to some roles
   * and not others would give a worker a false read of the market depending on
   * where they happened to be looking from.
   */
  it("gives every viewer the same answer", () => {
    for (const mode of ["manual", "autopilot"] as const) {
      const answers = [CLIENT, FREELANCER, ARBITER, PUBLIC].map((v) =>
        clientModeFor(mode, v),
      );
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toBe(mode);
    }
  });
});

describe("jobActorFor — the colour a job's chrome takes", () => {
  it("paints an Autopilot job amber", () => {
    expect(jobActorFor("autopilot", CLIENT)).toBe("agent");
    expect(jobActorFor("autopilot", FREELANCER)).toBe("agent");
  });

  it("paints a manual job teal", () => {
    expect(jobActorFor("manual", CLIENT)).toBe("human");
    expect(jobActorFor("manual", FREELANCER)).toBe("human");
  });

  it("paints the same colour for every viewer", () => {
    for (const mode of ["manual", "autopilot"] as const) {
      const colours = [CLIENT, FREELANCER, ARBITER, PUBLIC].map((v) =>
        jobActorFor(mode, v),
      );
      expect(new Set(colours).size).toBe(1);
    }
  });
});

describe("actor → class mapping", () => {
  it("maps each actor to its scope class", () => {
    expect(actorClass("human")).toBe("actor-human");
    expect(actorClass("agent")).toBe("actor-agent");
  });

  it("never returns the same class for both actors", () => {
    expect(actorClass("human")).not.toBe(actorClass("agent"));
  });

  it("derives the actor from the management mode", () => {
    expect(actorForMode("autopilot")).toBe("agent");
    expect(actorForMode("manual")).toBe("human");
  });
});
