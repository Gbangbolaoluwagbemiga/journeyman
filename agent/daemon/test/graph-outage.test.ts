import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * WHEN THE SUBGRAPH STOPS ANSWERING, THE AGENT MUST NOT STOP HIRING.
 *
 * This is written from a live incident. Graph Studio started returning HTTP 429
 * and the daemon spent 55 minutes in a tight loop:
 *
 *   [poller] task delegated-7 failed: GraphQL HTTP 429
 *   [poller] LLM rate-limited — pausing LLM work for 60s
 *
 * Two separate bugs stacked on each other. The read for a job's applications
 * threw instead of falling back to the chain — even though the fallback was
 * already written and was being used when GRAPH_URL was simply unset. And the
 * poller's catch block tested the failure message with a bare /429/, so The
 * Graph's rate limit was read as the language model's and paused the agent's
 * brain for a minute at a time.
 *
 * Meanwhile one freelancer had applied, on chain, three minutes into a job, and
 * the client's screen kept saying "the agent hasn't read the applications yet".
 * The applications were in the chain logs the entire time.
 */

const applicationsFromChain = vi.fn();
const escrowFromChain = vi.fn();

vi.mock("../src/graph/chain-fallback.js", () => ({
  applicationsFromChain: (id: string) => applicationsFromChain(id),
  escrowFromChain: (id: string) => escrowFromChain(id),
}));

vi.mock("../src/config.js", () => ({
  config: { get graphUrl() { return graphUrl; } },
}));

let graphUrl = "https://api.studio.thegraph.com/query/atelier";

const APPLICATIONS = `query GetJobApplications($escrowId: String!) { escrow(id: $escrowId) { applications { freelancer } } }`;
const BY_ID = `query GetJobById($escrowId: String!) { escrow(id: $escrowId) { title } }`;
const LIST = `query GetOpenJobs { escrows { id } }`;

let graphQuery: typeof import("../src/graph/client.js").graphQuery;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  graphUrl = "https://api.studio.thegraph.com/query/atelier";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ({ graphQuery } = await import("../src/graph/client.js"));

  applicationsFromChain.mockResolvedValue({
    escrow: { escrowId: "7", status: 0, applications: [{ freelancer: "0xabc", coverLetter: "hi" }] },
  });
  escrowFromChain.mockResolvedValue({ escrow: { id: "7", title: "Landing page" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respond(status: number, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })));
}

describe("reading applications while the subgraph is rate-limited", () => {
  it("falls back to the chain on a 429 rather than failing the hire loop", async () => {
    respond(429);

    const out = await graphQuery<any>(APPLICATIONS, { escrowId: "7" });

    // The exact shape the scorer expects, sourced from chain logs.
    expect(out.escrow.applications).toHaveLength(1);
    expect(applicationsFromChain).toHaveBeenCalledWith("7");
  });

  it("falls back on a 5xx and on an outright network failure too", async () => {
    respond(503);
    await expect(graphQuery<any>(APPLICATIONS, { escrowId: "7" })).resolves.toBeTruthy();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    await expect(graphQuery<any>(APPLICATIONS, { escrowId: "7" })).resolves.toBeTruthy();
  });

  it("falls back when the subgraph answers 200 with a GraphQL error body", async () => {
    // An indexing subgraph returns HTTP 200 and an errors array. It is just as
    // unable to answer as a 429, and used to throw identically.
    respond(200, { errors: [{ message: "indexing_error: block 1234 not indexed" }] });

    const out = await graphQuery<any>(APPLICATIONS, { escrowId: "7" });
    expect(out.escrow.applications).toHaveLength(1);
  });

  it("covers the single-escrow read as well, not only applications", async () => {
    respond(429);
    const out = await graphQuery<any>(BY_ID, { escrowId: "7" });
    expect(out.escrow.title).toBe("Landing page");
  });

  it("still throws for a query the chain cannot answer", async () => {
    // Lists and history have no chain equivalent. A silent empty page there
    // would be worse than a loud failure — a browse page that looks like
    // "no jobs exist" instead of "the index is down".
    respond(429);
    await expect(graphQuery(LIST)).rejects.toThrow(/429/);
    expect(applicationsFromChain).not.toHaveBeenCalled();
  });

  it("prefers the subgraph while it is healthy", async () => {
    respond(200, { data: { escrow: { applications: [] } } });
    const out = await graphQuery<any>(APPLICATIONS, { escrowId: "7" });
    expect(out.escrow.applications).toEqual([]);
    expect(applicationsFromChain).not.toHaveBeenCalled();
  });

  it("keeps working when there is no subgraph configured at all", async () => {
    graphUrl = "";
    const out = await graphQuery<any>(APPLICATIONS, { escrowId: "7" });
    expect(out.escrow.applications).toHaveLength(1);
  });
});

describe("telling the two rate limits apart", () => {
  it("does not treat a subgraph 429 as the language model's", async () => {
    const { isLlmRateLimit } = await import("../src/llm-status.js");

    // The message that caused the 55-minute loop.
    expect(isLlmRateLimit("GraphQL HTTP 429")).toBe(false);
    expect(isLlmRateLimit("GraphQL HTTP 503")).toBe(false);

    // A real one still has to pause hiring, or a quiet afternoon of 429s
    // burns a good milestone's five review attempts.
    expect(isLlmRateLimit("429 rate_limit_exceeded on llama-3.3-70b")).toBe(true);
    expect(isLlmRateLimit("Groq rate limit reached — daily token budget exhausted")).toBe(true);
  });
});
