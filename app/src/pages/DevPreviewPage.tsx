/**
 * DEV-ONLY component preview.
 *
 * Most of Atelier's new surfaces only appear inside a client's own escrow card,
 * which means seeing them requires a connected wallet that happens to be the
 * depositor on a job the daemon also knows about. That is a long setup for
 * "does the decision log render", and it is a long setup that has to be redone
 * every time someone new picks up the repo.
 *
 * This page renders those surfaces directly against the live local daemon.
 *
 * It is gated on `import.meta.env.DEV`, so it is not merely hidden in
 * production — the route does not exist there and Rollup drops the component.
 * That matters more than it looks: this page would happily show one client's
 * decision log to anybody who guessed the URL.
 */

import { useState } from "react";
import { DecisionLog } from "@/components/atelier/decision-log";
import { JobDecisionLog } from "@/components/atelier/job-decision-log";
import { useDecisions } from "@/hooks/use-decisions";
import { AUTOPILOT_CONFIGURED } from "@/lib/atelier/agent-api";
import type { Decision } from "@/lib/atelier/actor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** A hand-built log, so the colour semantic is visible with the daemon down. */
const SAMPLE: Decision[] = [
  { id: "s1", by: "agent", action: "Brief written", rationale: "Rewrote the one-line request as a brief: wordmark plus a stacked lockup, SVG and PNG at 2x, two revision rounds.", at: Date.now() - 5_400_000 },
  { id: "s2", by: "agent", action: "Shortlisted 3 of 19", rationale: "Only three portfolios showed type work in a comparable register. The rest were illustration.", at: Date.now() - 4_800_000 },
  { id: "s3", by: "agent", action: "Freelancer hired", rationale: "Highest scorer answered the stacked-lockup requirement specifically rather than generically.", at: Date.now() - 4_200_000 },
  { id: "s4", by: "agent", action: "Payment released", rationale: "Milestone 1 meets the brief — three distinct directions, correct format, legible at 16px.", at: Date.now() - 1_800_000, amountUsdc: "20.00", txHash: "0x9f2c4a1b8e7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f" },
  { id: "s5", by: "human", action: "Escalated to a human arbiter", rationale: "Revision rounds exhausted and the freelancer disputes the assessment. This is not a call the agent should make twice.", at: Date.now() - 900_000 },
  { id: "s6", by: "human", action: "Dispute resolved", rationale: "Arbiter ruled a partial split: the brief was ambiguous about scope, so the work was not wholly outside it.", at: Date.now() - 300_000, amountUsdc: "30.00" },
];

function Section({
  title,
  note,
  testId,
  children,
}: {
  title: string;
  note: string;
  /* Tests must be able to tell the hand-written sample apart from the live
     daemon data. Without this, a selector matching both would silently assert
     against the sample and prove nothing about the integration. */
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12" data-testid={testId}>
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground mt-1.5 mb-5 max-w-prose">{note}</p>
      {children}
    </section>
  );
}

export default function DevPreviewPage() {
  const [escrowId, setEscrowId] = useState("1");
  const live = useDecisions(escrowId);

  return (
    <div className="container mx-auto px-4 py-12 max-w-3xl">
      <span className="actor-chip">Dev only</span>
      <h1 className="font-display text-4xl font-bold tracking-tight mt-4">
        Atelier surfaces
      </h1>
      <p className="text-muted-foreground mt-3">
        Rendered directly, so they can be checked without a wallet. This route
        exists only in dev builds.
      </p>

      <div className="mt-6 rounded-xl glass p-4 text-sm">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${AUTOPILOT_CONFIGURED ? "bg-[var(--actor-agent)]" : "bg-destructive"}`}
          />
          <span>
            Autopilot daemon:{" "}
            {AUTOPILOT_CONFIGURED ? (
              <code className="font-mono text-xs">
                {import.meta.env.VITE_AGENT_API_URL}
              </code>
            ) : (
              "not configured — set VITE_AGENT_API_URL"
            )}
          </span>
        </div>
      </div>

      <Section
        testId="sample-log"
        title="The colour semantic"
        note="Teal is a decision a person made; amber is one the agent made. This log escalates two thirds of the way down, and the trail turns teal from that point and stays teal — the record of a machine handing control back."
      >
        <DecisionLog decisions={SAMPLE} />
      </Section>

      <Section
        testId="live-log"
        title="A real job's log, from the daemon"
        note="Live data from the running daemon, joined task → escrow. Seed some with `node scripts/seed-local-demo.mjs 1 2` from the repo root."
      >
        <div className="mb-4 max-w-[16rem]">
          <Label htmlFor="escrow" className="text-xs">
            Escrow id
          </Label>
          <Input
            id="escrow"
            value={escrowId}
            onChange={(e) => setEscrowId(e.target.value)}
            className="mt-1.5"
          />
        </div>

        {live.error && (
          <p className="text-sm text-destructive mb-3">{live.error}</p>
        )}
        <p className="text-xs text-muted-foreground mb-3">
          {live.loading ? "loading…" : `${live.decisions.length} decisions`}
        </p>
        <DecisionLog
          decisions={live.decisions}
          emptyMessage="No agent activity recorded for this escrow — which is what a manually-managed job looks like."
        />
      </Section>

      <Section
        testId="collapsed-log"
        title="Collapsed, as it appears in a job card"
        note="How the log actually ships: one line inside the escrow card, opened on demand, so a client scanning six jobs is not scrolling past forty entries."
      >
        <JobDecisionLog escrowId={escrowId} isClient />
      </Section>
    </div>
  );
}
