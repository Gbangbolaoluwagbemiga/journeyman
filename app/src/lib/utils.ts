import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** USDC contract on Arc Testnet — set VITE_USDC_TOKEN_CONTRACT in .env */
const USDC_ADDRESS = (
  (typeof import.meta !== "undefined" ? (import.meta as any).env?.VITE_USDC_TOKEN_CONTRACT : undefined) ?? ""
).trim().toLowerCase();

/**
 * Resolve token metadata from its contract address.
 * address(0) = native USDC on Arc Testnet (6 decimals)
 * Other ERC-20 tokens can be added as needed
 */
function tokenMeta(tokenAddress?: string | null): { symbol: string; decimals: number } {
  const addr = (tokenAddress ?? "").toLowerCase();
  // Native token on Arc Testnet is USDC (6 decimals)
  if (!addr || addr === ZERO_ADDRESS) return { symbol: "USDC", decimals: 6 };
  if (USDC_ADDRESS && addr === USDC_ADDRESS) return { symbol: "USDC", decimals: 6 };
  // Unknown ERC-20: assume 18 decimals, show shortened address
  return { symbol: "tokens", decimals: 18 };
}

/**
 * Format a raw on-chain amount to a human-readable string with the correct
 * token symbol, respecting each token's decimal places.
 *
 * @param rawAmount  Raw contract amount (base units for native USDC or ERC-20)
 * @param tokenAddress  Token contract address (address(0) = native USDC)
 */
export function formatTokenAmount(
  rawAmount: string | number | bigint | undefined | null,
  tokenAddress?: string | null,
): string {
  if (rawAmount === undefined || rawAmount === null || rawAmount === "" || rawAmount === "0") {
    const { symbol } = tokenMeta(tokenAddress);
    return `0 ${symbol}`;
  }
  const { symbol, decimals } = tokenMeta(tokenAddress);
  const divisor = 10 ** decimals;
  try {
    const raw = typeof rawAmount === "bigint" ? rawAmount : BigInt(String(rawAmount).split(".")[0]);
    const bigDivisor = BigInt(divisor);
    const whole = raw / bigDivisor;
    const rem = Number(raw % bigDivisor) / divisor;
    const total = Number(whole) + rem;
    const maxDec = decimals === 6 ? 2 : 6; // USDC: 2dp, other tokens: 6dp
    return `${total.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: maxDec })} ${symbol}`;
  } catch {
    const n = parseFloat(String(rawAmount));
    if (isNaN(n)) return `0 ${symbol}`;
    return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol}`;
  }
}

/**
 * Convenience wrapper — formats USDC (native, 6 decimals).
 * For other ERC-20 amounts use formatTokenAmount(amount, tokenAddress).
 */
export function formatEth(weiAmount: string | number | bigint | undefined | null): string {
  return formatTokenAmount(weiAmount, ZERO_ADDRESS);
}

/**
 * Convert a raw amount to a plain number using the token's decimals.
 */
export function rawToNumber(
  rawAmount: string | number | bigint | undefined | null,
  tokenAddress?: string | null,
): number {
  if (!rawAmount) return 0;
  const { decimals } = tokenMeta(tokenAddress);
  try {
    return Number(BigInt(String(rawAmount).split(".")[0])) / 10 ** decimals;
  } catch {
    return parseFloat(String(rawAmount)) / 10 ** decimals || 0;
  }
}

/** @deprecated use rawToNumber instead */
export function weiToEth(weiAmount: string | number | bigint | undefined | null): number {
  return rawToNumber(weiAmount, ZERO_ADDRESS);
}

/**
 * Extracts an attachment markdown tag from description / cover-letter text.
 * Handles both `[Attachment: name](url)` (milestones) and
 * `[Portfolio/Attachment: name](url)` (job applications).
 */
export function parseAttachment(text: string): { body: string; text: string; attachment?: { name: string; url: string } } {
  // Match either variant: [Attachment: …] or [Portfolio/Attachment: …]
  const re = /\[(?:Portfolio\/)?Attachment:\s*([^\]]+)\]\((https?:\/\/[^)]+)\)/i;
  const match = re.exec(text);
  if (!match) return { body: text, text };
  const body = text.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    body,
    text: body,
    attachment: { name: match[1].trim(), url: match[2].trim() },
  };
}
