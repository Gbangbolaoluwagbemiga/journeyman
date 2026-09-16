import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE STANDARD A JOB IS JUDGED BY, MADE VISIBLE.
 *
 * Autopilot has always written acceptance criteria when a client hands a job
 * over — the brief generator runs on the escrow's own title and description.
 * What it never did was show anyone. The client signed a dialog that admitted
 * "it may judge against wording you have not seen", and the freelancer applied
 * against a web card that listed a title and a budget while the Telegram bot
 * printed the full criteria for the same job.
 *
 * Two things here are load-bearing:
 *
 *   the preview must be STABLE, or reopening the dialog shows a new standard
 *   what the client approved must WIN over what the model later regenerates
 */

const generateBrief = vi.fn();
const readContract = vi.fn();
const kv = new Map<string, string>();

vi.mock("../src/agent/BriefGenerator.js", () => ({ generateBrief }));
vi.mock("../src/web3/atelier.js", () => ({ getPublicClient: () => ({ readContract }) }));
vi.mock("../src/config.js", () => ({
  config: { atelierAddress: "0x00000000000000000000000000000000000A7E11", applicationWindowMinutes: 3 },
}));
vi.mock("../src/store.js", () => ({
  getPollerText: (k: string) => kv.get(k) ?? null,
  setPollerText: (k: string, v: string) => { kv.set(k, v); },
  listTasks: () => listTasks(),
}));

const listTasks = vi.fn(() => [] as any[]);

const h = await import("../src/agent/handover.js");

beforeEach(() => {
  kv.clear();
  vi.clearAllMocks();
  listTasks.mockReturnValue([]);
  readContract.mockResolvedValue({
    depositor: "0x1111111111111111111111111111111111111111",
    projectTitle: "Fireball illustration",
    projectDescription: "A vector fireball for a game HUD.",
  });
  generateBrief.mockResolvedValue({
    brief: { criteria: ["SVG + PNG at 1000x1000", "Transparent background"] },
  });
});

describe("previewing what Autopilot will judge by", () => {
  it("generates the criteria from what is on-chain", async () => {
    const out = await h.previewCriteria("7");
    expect(out.criteria).toEqual(["SVG + PNG at 1000x1000", "Transparent background"]);
    expect(out.title).toBe("Fireball illustration");
    // Generated from the escrow's own text, not from anything the caller sent.
    expect(generateBrief).toHaveBeenCalledWith("Fireball illustration\n\nA vector fireball for a game HUD.");
  });

  it("returns the SAME criteria when the dialog is reopened", async () => {
    const first = await h.previewCriteria("7");

    // A second generation would word them differently — the model is not
    // deterministic — so a client who closed and reopened the dialog would be
    // asked to approve a different standard than the one they just read.
    generateBrief.mockResolvedValue({ brief: { criteria: ["something else entirely"] } });
    const second = await h.previewCriteria("7");

    expect(second).toEqual(first);
    expect(generateBrief).toHaveBeenCalledTimes(1);
  });
});

describe("the window a client may ask for", () => {
  it("accepts a minute through a week", () => {
    expect(h.clampWindow(1)).toBe(1);
    expect(h.clampWindow(30)).toBe(30);
    expect(h.clampWindow(10080)).toBe(10080);
  });

  it("refuses zero, negatives, nonsense and anything past a week", () => {
    // Zero would score the first application the instant it arrived, which is
    // the race the window exists to prevent.
    for (const bad of [0, -5, 10081, "soon", null, undefined, NaN, Infinity]) {
      expect(h.clampWindow(bad)).toBeNull();
    }
  });

  it("rounds a fractional request rather than rejecting it", () => {
    expect(h.clampWindow(2.4)).toBe(2);
    expect(h.clampWindow("15")).toBe(15);
  });
});

describe("the sentence the client signs", () => {
  it("names the job and the window, so it cannot be replayed onto another", () => {
    const a = h.handoverMessage("0xAbC0000000000000000000000000000000000001", "7", 30);
    expect(a).toContain("#7");
    expect(a).toContain("30 minute(s)");
    // Lower-cased so a checksummed address and a plain one produce one sentence.
    expect(a).toContain("0xabc0000000000000000000000000000000000001");

    expect(h.handoverMessage("0xAbC0000000000000000000000000000000000001", "8", 30)).not.toBe(a);
    expect(h.handoverMessage("0xAbC0000000000000000000000000000000000001", "7", 31)).not.toBe(a);
  });
});

describe("what the freelancer is shown", () => {
  it("prefers what the client actually approved", () => {
    h.savePrefs("7", { criteria: ["Approved one"], applicationWindowMinutes: 10, approvedAt: 1 });
    listTasks.mockReturnValue([{ escrowId: "7", briefJson: JSON.stringify({ criteria: ["Model's own"] }) }]);

    expect(h.criteriaFor("7")).toEqual({ criteria: ["Approved one"], source: "approved" });
  });

  it("falls back to the adopted brief for a job delegated before any of this existed", () => {
    listTasks.mockReturnValue([{ escrowId: "7", briefJson: JSON.stringify({ criteria: ["Model's own"] }) }]);
    expect(h.criteriaFor("7")).toEqual({ criteria: ["Model's own"], source: "brief" });
  });

  it("says plainly that there are none rather than inventing some", () => {
    expect(h.criteriaFor("7")).toEqual({ criteria: [], source: "none" });
  });

  it("survives a malformed brief instead of failing the whole read", () => {
    listTasks.mockReturnValue([{ escrowId: "7", briefJson: "{not json" }]);
    expect(h.criteriaFor("7").source).toBe("none");
  });
});

describe("previewing a job that is already running", () => {
  it("shows the brief it is actually judged by, not a fresh guess", async () => {
    // Escrow 7, live: title "fireball", description a Discord support request.
    // Run the generator twice on that and you get two unrelated jobs. A preview
    // that regenerates is not previewing anything — it puts a second standard
    // on screen that nobody is being measured against.
    listTasks.mockReturnValue([
      { escrowId: "7", briefJson: JSON.stringify({ criteria: ["The standard in force"] }) },
    ]);

    const out = await h.previewCriteria("7");

    expect(out.criteria).toEqual(["The standard in force"]);
    expect(generateBrief).not.toHaveBeenCalled();
  });

  it("still generates for a job that has never been adopted", async () => {
    const out = await h.previewCriteria("7");
    expect(generateBrief).toHaveBeenCalledTimes(1);
    expect(out.criteria).toEqual(["SVG + PNG at 1000x1000", "Transparent background"]);
  });
});

describe("a preview taken before the job was adopted", () => {
  it("is superseded by the brief once the agent is actually running it", async () => {
    // Order of precedence, learned the hard way on escrow 7: the cache was
    // checked first, so a preview generated before adoption kept being served
    // after it — and the dialog quoted a standard nobody was measured against.
    await h.previewCriteria("7"); // caches the generated pair
    expect(generateBrief).toHaveBeenCalledTimes(1);

    listTasks.mockReturnValue([
      { escrowId: "7", briefJson: JSON.stringify({ criteria: ["What it is really judged by"] }) },
    ]);

    expect((await h.previewCriteria("7")).criteria).toEqual(["What it is really judged by"]);
    expect(generateBrief).toHaveBeenCalledTimes(1); // no second generation either
  });
});

describe("a brief whose title fights its description", () => {
  it("carries the conflict through to the client, rather than swallowing it", async () => {
    generateBrief.mockResolvedValue({
      brief: {
        criteria: ["The \"sus\" role is removed"],
        titleMatchesWork: false,
        titleConflict: 'The title "fireball" implies an illustration; the description asks for a Discord role removal.',
      },
    });

    const out = await h.previewCriteria("7");

    expect(out.titleConflict).toMatch(/fireball/);
    // The brief itself still comes from the description — the title never wins.
    expect(out.criteria).toEqual(['The "sus" role is removed']);
  });

  it("says nothing when the two agree", async () => {
    generateBrief.mockResolvedValue({
      brief: { criteria: ["SVG + PNG"], titleMatchesWork: true, titleConflict: "" },
    });

    expect((await h.previewCriteria("7")).titleConflict).toBeUndefined();
  });

  it("says nothing when the model omits the fields entirely", async () => {
    // An older cached brief, or a model that dropped the field. Absence is not
    // a conflict, and a warning nobody can act on is worse than silence.
    generateBrief.mockResolvedValue({ brief: { criteria: ["SVG + PNG"] } });

    expect((await h.previewCriteria("7")).titleConflict).toBeUndefined();
  });
})
