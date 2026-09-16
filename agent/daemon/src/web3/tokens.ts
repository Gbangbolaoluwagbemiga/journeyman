// tokens.ts — which tokens an escrow may actually be funded in.
//
// The contract stores the whitelist as `mapping(address => bool)`, which can be
// asked about a token but cannot be listed. So the set is reconstructed from
// TokenWhitelisted logs and then re-checked against the mapping: a token that
// was whitelisted and later removed still has its log forever, and paying that
// out would revert at createEscrow. The log tells us what to ask about; the
// mapping is the answer.
import { erc20Abi, getAddress, type Abi } from "viem";
import atelierAbi from "./AtelierABI.json" with { type: "json" };
import { config } from "../config.js";
import { getLogClient, getPublicClient } from "./atelier.js";

const abi = atelierAbi as Abi;

export interface WhitelistedToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /** True for the chain's own currency. On Arc that is USDC itself. */
  native: boolean;
}

/**
 * Cached because this is several RPC round-trips and the answer changes only
 * when an admin whitelists or delists something, which is rare and manual.
 */
let cache: { at: number; tokens: WhitelistedToken[] } | null = null;
const TTL_MS = 5 * 60_000;

export function invalidateTokenCache(): void {
  cache = null;
}

async function readTokenMeta(address: `0x${string}`): Promise<{ symbol: string; decimals: number }> {
  const client = getPublicClient();
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    ]);
    return { symbol, decimals };
  } catch {
    // A token that does not answer symbol()/decimals() is still spendable —
    // it is whitelisted on-chain, which is the only thing that decides whether
    // createEscrow accepts it. Show the address rather than hiding the option.
    return { symbol: `${address.slice(0, 6)}…${address.slice(-4)}`, decimals: 18 };
  }
}

export async function listWhitelistedTokens(): Promise<WhitelistedToken[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tokens;

  const client = getLogClient();
  const event = {
    type: "event",
    name: "TokenWhitelisted",
    inputs: [{ name: "token", type: "address", indexed: true }],
  } as const;

  // Walked in windows because public RPCs refuse a wide getLogs range outright
  // rather than truncating it -- one call over the limit returns no data at all,
  // not less data.
  const latest = await client.getBlockNumber();
  const seen = new Set<string>();
  for (let from = config.atelierDeployBlock; from <= latest; from += config.logRangeLimit + 1n) {
    const to = from + config.logRangeLimit > latest ? latest : from + config.logRangeLimit;
    const logs = await client.getLogs({ address: config.atelierAddress, event, fromBlock: from, toBlock: to });
    for (const log of logs) {
      const t = (log as { args?: { token?: string } }).args?.token;
      if (t) seen.add(getAddress(t));
    }
  }

  const candidates = [...seen] as `0x${string}`[];
  const stillListed = await Promise.all(
    candidates.map((address) =>
      client
        .readContract({ address: config.atelierAddress, abi, functionName: "whitelistedTokens", args: [address] })
        .then((ok) => (ok ? address : null))
        .catch(() => null),
    ),
  );

  const live = stillListed.filter((a): a is `0x${string}` => a !== null);
  const tokens = await Promise.all(
    live.map(async (address) => ({
      address,
      ...(await readTokenMeta(address)),
      native: address.toLowerCase() === config.usdcAddress.toLowerCase(),
    })),
  );

  tokens.sort((a, b) => (a.native === b.native ? a.symbol.localeCompare(b.symbol) : a.native ? -1 : 1));
  cache = { at: Date.now(), tokens };
  return tokens;
}

/** Whether a client's chosen token is one the contract will actually accept. */
export async function isPayable(address: string): Promise<boolean> {
  const tokens = await listWhitelistedTokens();
  return tokens.some((t) => t.address.toLowerCase() === address.toLowerCase());
}
