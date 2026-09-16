/**
 * Copy the compiled contract ABI into the frontend.
 *
 * There are two ABI files in src/lib/web3 with different shapes and different
 * consumers — the full Foundry artifact (hooks read `.abi` off it) and a bare
 * array (abis.ts imports it directly). They were hand-maintained, which is how
 * an ABI ends up describing a contract that no longer exists: the interesting
 * failure is not a crash but a silent one, where a call to a function the
 * deployed contract does have is encoded from a stale signature and reverts
 * with no useful message.
 *
 *   npm run sync-abi
 *
 * Run it after every `forge build` that changes the contract surface. It fails
 * loudly if the artifact is missing rather than leaving the old ABI in place.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const ARTIFACT = resolve(root, "contracts/solidity/out/Atelier.sol/Atelier.json");
const FULL = resolve(root, "src/lib/web3/AtelierABI.json");
const BARE = resolve(root, "src/lib/web3/atelier-abi.json");
/*
 * The daemon keeps its own copy and this script did not touch it, so the two
 * drifted silently: the frontend learned about a new function and the agent did
 * not. Nothing fails loudly when that happens — a call just encodes against an
 * ABI missing the entry it needs.
 */
const DAEMON = resolve(root, "../agent/daemon/src/web3/AtelierABI.json");

if (!existsSync(ARTIFACT)) {
  console.error(
    `No artifact at ${ARTIFACT}\nRun 'forge build' in contracts/solidity first.`,
  );
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
  console.error("Artifact has no ABI. Did the build actually succeed?");
  process.exit(1);
}

const before = existsSync(BARE)
  ? JSON.parse(readFileSync(BARE, "utf8")).length
  : 0;

/* The full artifact keeps its original shape — hooks read `.abi`, and DashboardPage
   reads bytecode — so only the abi field is replaced. */
const existingFull = existsSync(FULL)
  ? JSON.parse(readFileSync(FULL, "utf8"))
  : {};
writeFileSync(
  FULL,
  JSON.stringify({ ...existingFull, ...artifact }, null, 2) + "\n",
);
writeFileSync(BARE, JSON.stringify(artifact.abi, null, 2) + "\n");
if (existsSync(DAEMON)) {
  // A bare array, which is the shape the daemon imports and casts to Abi.
  writeFileSync(DAEMON, JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log("Daemon ABI synced too.");
}

const names = artifact.abi
  .filter((e) => e.type === "function")
  .map((e) => e.name)
  .sort();

console.log(`ABI synced: ${before} -> ${artifact.abi.length} entries`);
console.log(`${names.length} functions`);

/* Named explicitly so a missing delegation function is caught here rather than
   as a failed transaction in someone's wallet. */
for (const required of ["setJobManager", "revokeJobManager", "isJobManager", "jobManager"]) {
  if (!names.includes(required)) {
    console.error(`MISSING from ABI: ${required}`);
    process.exit(1);
  }
}
console.log("Autopilot delegation surface present.");
