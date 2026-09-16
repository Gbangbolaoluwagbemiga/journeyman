import { describe, it, expect } from "vitest";
import { ContractService } from "@/lib/web3/contract-service";

/**
 * THE METHODS THE UI ACTUALLY CALLS, ON THE REAL CLASS.
 *
 * Every component test mocks ContractService — it has to, since the real one
 * talks to a chain. The cost of that is a blind spot exactly the width of this
 * file: a method can be deleted from the class and every one of those tests
 * still passes, because they were asserting against a stand-in that still has
 * it.
 *
 * That happened. `getYieldStatus` and `setYieldOptIn` were removed by a bad
 * edit, three call sites kept calling them, the suite stayed green, and the
 * first sign was a blank page reading "getYieldStatus is not a function".
 *
 * So this asserts the shape of the real thing, with no mock anywhere near it.
 * It does not call anything — there is no chain here — it only insists the
 * methods exist. Cheap, and it closes the exact hole.
 */

/** Every method some component or page invokes on a ContractService. */
const CALLED_BY_THE_UI = [
  // yield — the 🌱 tag and the posting-time fee choice
  "getYieldStatus",
  "setYieldOptIn",
  "setWorkIntent",
  "isEarningYield",
  // hiring
  "acceptFreelancer",
  "getApplicationDetails",
  "getEscrow",
  "getMilestones",
  // reputation
  "getAverageRating",
  "getAverageClientRating",
  "getBadge",
  // the client's exits
  "withdrawJobFunds",
  "reopenJob",
  "declineAssignment",
  "cancelJob",
  // autopilot
  "setJobManager",
  "revokeJobManager",
] as const;

describe("the real ContractService", () => {
  const svc = new ContractService("0x0000000000000000000000000000000000000001");

  it.each(CALLED_BY_THE_UI)("still has %s", (name) => {
    expect(typeof (svc as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  /* The deletion that caused this file removed a method and left its callers
     compiling, because `npx tsc --noEmit` on a solution tsconfig checks nothing.
     Guard the pair that has actually gone missing once. */
  it("exposes the yield pair the job card and the posting screen depend on", () => {
    expect(svc.getYieldStatus).toBeTypeOf("function");
    expect(svc.setYieldOptIn).toBeTypeOf("function");
  });
});
