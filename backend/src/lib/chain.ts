import { createPublicClient, http } from "viem";

/**
 * One chain client for the whole API.
 *
 * WHY THIS IS A MODULE AND NOT THREE COPIES
 *
 * Analytics, disputes and upload each built their own publicClient off their
 * own `process.env.ARC_RPC_URL || <some Arc endpoint>`, and the three fallbacks
 * were not even the same host. So "which chain is the API reading?" had three
 * answers depending on which route you asked, and the port to Arbitrum could be
 * done correctly in one file and still leave the other two reading a dead
 * network — returning zeros, which every caller renders as "no jobs yet".
 *
 * WHY THE OLD ENV NAME IS NOT ACCEPTED AS A FALLBACK
 *
 * The deployed API still has ARC_RPC_URL set in its environment, and it points
 * at Arc. Reading it "for compatibility" would mean the live service quietly
 * keeps reading the wrong chain after this ships, with nothing in the logs to
 * say so. Ignoring it means a stale variable falls through to the default
 * below, which is right. Set ARB_RPC_URL to override.
 */
export const rpcUrl = process.env.ARB_RPC_URL?.trim() || "https://sepolia-rollup.arbitrum.io/rpc";

/**
 * The Journeyman proxy. Defaulted rather than left undefined because an unset
 * CONTRACT_ADDRESS does not fail — it makes every on-chain read return nothing,
 * which renders as an empty marketplace rather than as an outage.
 */
export const contractAddress = (process.env.CONTRACT_ADDRESS?.trim() ||
  "0x5128B3E2a20d483f68834b26505aFD7457C282dc") as `0x${string}`;

export const publicClient = createPublicClient({ transport: http(rpcUrl) });
