import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** USDC on Arbitrum Sepolia — override with VITE_USDC_TOKEN_CONTRACT. */
export const USDC_ADDRESS = (
  (typeof import.meta !== "undefined" ? (import.meta as any).env?.VITE_USDC_TOKEN_CONTRACT : undefined) ??
  "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
).trim().toLowerCase();

/**
 * Resolve token metadata from its contract address.
 *
 * ADDRESS(0) IS ETH HERE. IT USED TO BE USDC.
 *
 * On the chain this was built for, the native currency WAS USDC, so address(0)
 * meant six-decimal dollars and this function said so. Arbitrum's native
 * currency is ETH with eighteen decimals, and the contract still accepts
 * address(0) escrows without whitelisting them — see the NATIVE_TOKEN branch in
 * Journeyman.createEscrow. So a native escrow here holds ETH, and labelling it
 * USDC at six decimals would render one ether as "1,000,000,000,000 USDC".
 *
 * Every caller that means "our settlement currency" should say USDC explicitly;
 * formatUsdc below is the short way to do it.
 */
function tokenMeta(tokenAddress?: string | null): { symbol: string; decimals: number } {
  const addr = (tokenAddress ?? "").toLowerCase();
  if (!addr || addr === ZERO_ADDRESS) return { symbol: "ETH", decimals: 18 };
  if (addr === USDC_ADDRESS) return { symbol: "USDC", decimals: 6 };
  // Unknown ERC-20: assume 18 decimals, which is the common case.
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
 * Format an amount of the settlement currency — USDC, 6 decimals.
 *
 * This is what almost every figure in the product is: a budget, a milestone, a
 * payout, a total earned. It passed ZERO_ADDRESS to mean "the native currency,
 * which is USDC", and that stopped being true at the chain boundary.
 */
export function formatUsdc(amount: string | number | bigint | undefined | null): string {
  return formatTokenAmount(amount, USDC_ADDRESS);
}

/** @deprecated misleading name — it never formatted ether. Use formatUsdc. */
export const formatEth = formatUsdc;

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

/** @deprecated use rawToNumber with an explicit token address instead. */
export function weiToEth(amount: string | number | bigint | undefined | null): number {
  return rawToNumber(amount, USDC_ADDRESS);
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
