/**
 * Seed the LOCAL Atelier daemon with demo activity, so the Autopilot surfaces in
 * Atelier have something to render while you click around.
 *
 *   node scripts/seed-local-demo.mjs [escrowId ...]
 *
 * WHAT THIS IS, PRECISELY: rows in the daemon's local SQLite, describing
 * decisions an agent did not actually make, about escrows that may not exist.
 * Nothing here touches a chain, spends USDC, or leaves your machine.
 *
 * WHY IT EXISTS: a freshly-started daemon has an empty database, so the decision
 * log renders nothing and there is no way to see whether it works. The
 * production daemon has real history, but pointing a dev frontend at production
 * to get pretty screenshots is how demo data ends up in a submission video.
 *
 * WHAT IT IS NOT FOR: screenshots, videos, or anything a judge will see. Every
 * number in the submission has to be readable off-chain or off the subgraph.
 * Reasonings below are written to be obviously synthetic if one ever leaks.
 *
 * Undo with:  rm agent/daemon/data/atelier.db   (then restart the daemon)
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DB = resolve(here, "../agent/daemon/data/atelier.db");

if (!existsSync(DB)) {
  console.error(
    `No database at ${DB}\nStart the daemon once so it creates the schema, then run this again.`,
  );
  process.exit(1);
}

/* Escrow ids to attach the demo jobs to. Pass your own so the log lines up with
   escrows your wallet can actually open in My Jobs. */
const escrowIds = process.argv.slice(2);
/*
 * Default to a high range, not 1 and 2.
 *
 * Real escrow ids start at 1, so seeding there put a fake task on the same id
 * as a genuine job the moment a fresh contract was deployed. The reconciler
 * then fought the poller over which status escrow 2 had, and deleting the demo
 * rows was the only way to tell them apart. Ids up here will not collide with
 * anything a testnet deployment reaches.
 */
if (escrowIds.length === 0) escrowIds.push("9001", "9002");

const db = new DatabaseSync(DB);
const now = Date.now();
const min = 60_000;

/** A job the agent ran start to finish. Reads amber the whole way down. */
function cleanRun(escrowId, t0) {
  return [
    ["brief_generated", "[LOCAL DEMO] Rewrote the one-line request as a brief: wordmark plus a stacked lockup, SVG and PNG at 2x, two revision rounds. Budget split 40/60 across two milestones.", null, null, t0],
    ["job_posted", "[LOCAL DEMO] Escrow funded and the job posted to the open board.", null, null, t0 + 2 * min],
    ["applications_fetched", "[LOCAL DEMO] Collected 19 applications after the 3-minute window closed.", null, null, t0 + 5 * min],
    ["application_scored", "[LOCAL DEMO] Scored highest: portfolio shows three wordmarks in a comparable register, and the cover letter answers the stacked-lockup requirement specifically rather than generically.", "0x0b0b000000000000000000000000000000000b0b", 91, t0 + 6 * min],
    ["application_scored", "[LOCAL DEMO] Strong portfolio, but every sample is illustration rather than type. Not a fit for a wordmark brief.", "0x0475107000000000000000000000000000047510", 64, t0 + 6 * min + 1000],
    ["applicant_accepted", "[LOCAL DEMO] Hired the highest scorer. Nobody else cleared the bar by enough to be worth a second window.", "0x0b0b000000000000000000000000000000000b0b", 91, t0 + 7 * min],
    ["work_submitted", "[LOCAL DEMO] Milestone 1 delivered: three wordmark directions as SVG.", null, null, t0 + 40 * min],
    ["work_approved", "[LOCAL DEMO] Meets the brief — three distinct directions, correct format, legible at 16px. Releasing milestone 1.", null, null, t0 + 42 * min],
    ["payment_released", "[LOCAL DEMO] Paid milestone 1 to the freelancer.", "0x0b0b000000000000000000000000000000000b0b", null, t0 + 42 * min + 500],
  ];
}

/** A job that goes wrong and gets handed to a human. Turns teal partway down. */
function escalatedRun(escrowId, t0) {
  return [
    ["brief_generated", "[LOCAL DEMO] Brief: 800 words on stablecoin settlement, technical register, one revision round.", null, null, t0],
    ["job_posted", "[LOCAL DEMO] Escrow funded and posted.", null, null, t0 + 2 * min],
    ["applicant_accepted", "[LOCAL DEMO] Hired on the strength of two published pieces on payment rails.", "0x0b0b000000000000000000000000000000000b0b", 84, t0 + 9 * min],
    ["work_submitted", "[LOCAL DEMO] Milestone 1 delivered: 820 words.", null, null, t0 + 30 * min],
    ["work_rejected", "[LOCAL DEMO] Does not meet the brief: the piece describes card settlement throughout and mentions stablecoins twice in passing. Requesting a revision against the stated topic.", null, null, t0 + 33 * min],
    ["revision_requested", "[LOCAL DEMO] Revision round 1 of 1 opened, with the rejection reasoning attached.", null, null, t0 + 33 * min + 500],
    ["work_submitted", "[LOCAL DEMO] Revision delivered.", null, null, t0 + 50 * min],
    ["work_rejected", "[LOCAL DEMO] Still off-topic in the same way. Revision rounds exhausted.", null, null, t0 + 52 * min],
    ["escalated_to_human", "[LOCAL DEMO] Revision limit reached and the freelancer disputes the assessment. Handing to a human arbiter — this is not a call the agent should make twice.", null, null, t0 + 53 * min],
    ["dispute_resolved", "[LOCAL DEMO] Arbiter ruled a partial split: the brief was ambiguous about scope, so the work was not wholly outside it.", null, null, t0 + 90 * min],
  ];
}

const insertTask = db.prepare(
  `INSERT OR REPLACE INTO tasks (id, escrow_id, instruction, client_type, status, brief_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const insertDecision = db.prepare(
  `INSERT OR REPLACE INTO decisions (id, task_id, type, reasoning, target, score, timestamp)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

const shapes = [
  { make: cleanRun, instruction: "[LOCAL DEMO] A logo for a coffee roastery. Budget $50, 3 days.", clientType: "human", status: "in_progress" },
  { make: escalatedRun, instruction: "[LOCAL DEMO] 800 words on stablecoin settlement. Budget $120, 5 days.", clientType: "agent", status: "disputed" },
];

let decisionCount = 0;
escrowIds.forEach((escrowId, i) => {
  const shape = shapes[i % shapes.length];
  const taskId = `local-demo-${escrowId}`;
  const t0 = now - (i + 1) * 3 * 60 * min;

  insertTask.run(taskId, String(escrowId), shape.instruction, shape.clientType, shape.status, null, t0);

  for (const [type, reasoning, target, score, ts] of shape.make(escrowId, t0)) {
    insertDecision.run(randomUUID(), taskId, type, reasoning, target, score, ts);
    decisionCount++;
  }
  console.log(`escrow ${escrowId}: ${shape.status} (task ${taskId})`);
});

console.log(`\nSeeded ${escrowIds.length} demo jobs, ${decisionCount} decisions.`);
console.log("Restart is not needed — the daemon reads SQLite per request.");
console.log("Undo: rm agent/daemon/data/atelier.db");
