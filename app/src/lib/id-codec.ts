/**
 * Deterministic, reversible obfuscation for on-chain escrow IDs.
 *
 * On-chain IDs are sequential integers (1, 2, 3…) which are public by design
 * on any EVM chain. This codec makes them look opaque in the UI (e.g. "SF-LK4X9")
 * without adding any database or lookup table — encode/decode are pure functions.
 *
 * Security note: this is NOT encryption. Anyone with the source can reverse it.
 * The goal is UX professionalism and mild enumeration deterrence on API params,
 * not cryptographic hiding of on-chain data.
 */

// XOR mask — change this constant to produce a different output series
const MASK = 0x5f3759df;

// Base-36 alphabet (0-9 a-z), uppercase for display
const BASE = 36;

/**
 * Encode an on-chain numeric ID to a short opaque string.
 * encodeJobId(1) → "SF-LK4Q1"
 */
export function encodeJobId(id: number | string): string {
  const n = typeof id === "string" ? parseInt(id, 10) : id;
  if (!Number.isFinite(n) || n < 0) return String(id);
  const obfuscated = ((n ^ MASK) >>> 0).toString(BASE).toUpperCase();
  return `SF-${obfuscated}`;
}

/**
 * Decode an encoded ID back to the original numeric on-chain ID.
 * decodeJobId("SF-LK4Q1") → 1
 * Returns NaN if the input is not a valid encoded ID.
 */
export function decodeJobId(encoded: string): number {
  const raw = encoded.startsWith("SF-") ? encoded.slice(3) : encoded;
  const obfuscated = parseInt(raw, BASE);
  if (!Number.isFinite(obfuscated)) return NaN;
  return (obfuscated ^ MASK) >>> 0;
}
