import { createRequire } from "node:module";
import { createWalletClient, custom, type WalletClient } from "viem";
import { config, arcTestnet } from "../config.js";

// The Circle Developer-Controlled Wallets `/evm` subpath ships dual CJS/ESM builds,
// and its ESM named exports aren't reliably resolvable across Node versions — a
// static `import { createEIP1193Provider }` works on some Node versions but throws
// on others with "does not provide an export named 'createEIP1193Provider'". Load
// the CJS build explicitly via createRequire so the export is found deterministically.
// (This exact failure — and this fix — is documented in the Foreman project's Circle
// feedback notes from the same author; reused here rather than re-discovering it.)
const nodeRequire = createRequire(import.meta.url);
const { createEIP1193Provider } = nodeRequire(
  "@circle-fin/developer-controlled-wallets/evm",
) as typeof import("@circle-fin/developer-controlled-wallets/evm");

/* Same reason, same fix — the root package resolves the same way. */
const { initiateDeveloperControlledWalletsClient } = nodeRequire(
  "@circle-fin/developer-controlled-wallets",
) as typeof import("@circle-fin/developer-controlled-wallets");

/**
 * Custody via Circle Programmable Wallets (developer-controlled, MPC).
 *
 * Circle holds the key shares — Atelier NEVER sees a raw private key. Circle's
 * EIP-1193 provider drives the MPC wallet over the API; wrapped in a viem
 * WalletClient so the Agent Wallet can both:
 *   • sign x402 payment authorizations (EIP-712 `signTypedData`) — this is exactly
 *     the `BatchEvmSigner` shape the Gateway batching rail needs, so payments run
 *     under MPC, and
 *   • send arbitrary contract-write transactions on Arc — including Atelier's
 *     `createEscrow` / `acceptFreelancer` / `approveMilestone` — via `writeContract`,
 *     which works for any ABI (arrays, strings, structs) since it's just ABI-encoded
 *     calldata under the hood. This is what de-risks Phase 0 Spike A: a Circle
 *     Programmable Wallet CAN execute Atelier's complex writes, no hybrid
 *     viem-hot-wallet fallback needed.
 *
 * Shape matches `BatchEvmSigner` from @circle-fin/x402-batching: `{ address, signTypedData }`.
 */
export interface CircleSigner {
  readonly address: `0x${string}`;
  signTypedData: (params: {
    domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
  /** viem client bound to the MPC wallet — for on-chain txs (Atelier writes, Gateway deposit/withdraw). */
  readonly walletClient: WalletClient;
}

export function circleCustodyReady(): boolean {
  return !!(config.circleApiKey && config.circleEntitySecret && config.circleWalletAddress);
}

/**
 * Build an MPC-backed signer for ANY wallet under this Circle developer account.
 *
 * Atelier's treasury is one such wallet; a freelancer onboarded through the worker
 * layer is another. Circle's EIP-1193 provider is scoped to the developer account
 * and selects the wallet by address, so signing "as" a worker is the same call
 * path as signing as the treasury — no second SDK, no raw key on either side.
 *
 * This is what makes the managed-worker layer possible: a human can own a real
 * wallet, and have real transactions signed on their instruction, without ever
 * holding a key. See AGENT_INBOX.md.
 */
/**
 * Sign a plain message as one of our wallets — an EIP-191 personal_sign.
 *
 * Not through the EIP-1193 provider, which does not implement personal_sign at
 * all: viem's walletClient.signMessage comes straight back as "Method
 * personal_sign is not supported". Circle's own API does it, addressed by
 * wallet id rather than address, so this is the one signing path that does not
 * go through viem.
 *
 * Used to let a managed freelancer authorise a file upload. They hold no key,
 * so they cannot sign in a browser, and the backend rightly refuses an upload
 * without a signature from the escrow's beneficiary. The daemon signs on their
 * instruction, exactly as it already does to put their work on-chain.
 */
export async function signMessageAsWallet(walletId: string, message: string): Promise<`0x${string}`> {
  if (!config.circleApiKey || !config.circleEntitySecret) {
    throw new Error("Circle custody needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in daemon/.env");
  }

  const client = initiateDeveloperControlledWalletsClient({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
  });

  const res = (await client.signMessage({ walletId, message })) as {
    data?: { signature?: string };
  };
  const signature = res?.data?.signature;
  if (!signature) throw new Error("Circle returned no signature");
  return signature as `0x${string}`;
}

export function createSignerFor(address: `0x${string}`): CircleSigner {
  if (!config.circleApiKey || !config.circleEntitySecret) {
    throw new Error("Circle custody needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in daemon/.env");
  }

  const provider = createEIP1193Provider({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    chain: config.circleBlockchain as Parameters<typeof createEIP1193Provider>[0]["chain"],
  });
  const walletClient = createWalletClient({
    account: address,
    chain: arcTestnet,
    transport: custom(provider as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }),
  });

  return {
    address,
    walletClient,
    signTypedData: (params) =>
      (walletClient.signTypedData as (a: unknown) => Promise<`0x${string}`>)({
        account: address,
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      }),
  };
}

/** The Atelier Agent Wallet — the treasury. Default signer for everything Atelier does as itself. */
export function createCircleSigner(): CircleSigner {
  if (!config.circleWalletAddress) {
    throw new Error("Circle custody needs CIRCLE_WALLET_ADDRESS — run `npm run circle:setup` first");
  }
  return createSignerFor(config.circleWalletAddress as `0x${string}`);
}
