import React from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "viem";
import type { AppKitNetwork } from "@reown/appkit/networks";

// ─── Arc Testnet — defined as a viem Chain ────────────────────────────────────
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.drpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  /*
   * MULTICALL3, WHICH WAS ALWAYS THERE.
   *
   * Arc has multicall3 at the canonical address, and this chain never said so.
   * viem will not use a contract a chain has not declared, so every
   * `client.multicall(...)` in this app threw ChainDoesNotSupportContract and
   * fell into its fallback — which in every case was the sequential loop the
   * batch existed to replace. Escrows, milestones, the analytics page and the
   * autopilot badge were all doing one request per item while the code around
   * them explained why they didn't.
   *
   * Nothing was visibly broken, which is why it survived: the fallbacks worked.
   * They just spent N requests where one would do, against a public RPC that
   * answers `rate limit exceeded` under exactly that kind of load — and a
   * rate-limited read is where this app's worst bugs start.
   *
   * Verified deployed on Arc testnet (7618 bytes of code) before declaring it.
   */
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

// Cast to Reown's AppKitNetwork so it works with createAppKit and WagmiAdapter
const arcTestnetReown = arcTestnet as unknown as AppKitNetwork;

const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ?? "";

// ─── Wagmi adapter (Reown manages connectors: MetaMask, WC QR, Coinbase, etc.)
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [arcTestnetReown],
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

// ─── Reown AppKit initialisation ──────────────────────────────────────────────
createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [arcTestnetReown],
  defaultNetwork: arcTestnetReown,
  metadata: {
    name: "Atelier",
    description: "Milestone-based freelancer escrow on Arc EVM",
    url: typeof window !== "undefined" ? window.location.origin : "https://atelier.app",
    icons: ["/favicon.ico"],
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#7D00FF",
    "--w3m-border-radius-master": "8px",
  },
});

/*
 * WHY THE BALANCE NEEDED A HARD REFRESH.
 *
 * `refetchOnWindowFocus: false` told every wagmi query — the wallet balance
 * among them — never to re-read when you come back to the tab. So the one
 * moment a person is most likely to want a fresh number, having just signed
 * something in their wallet or watched a withdrawal land, was precisely the
 * moment nothing refetched. Reloading the page was the only way to see your own
 * money move.
 *
 * It is on now, with a short staleTime so returning to the tab repeatedly does
 * not turn into a request per glance. The chain is the source of truth and it
 * changes without asking us.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, staleTime: 10_000, retry: false },
  },
});

export const WalletProvider = ({ children }: { children: React.ReactNode }) => (
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  </WagmiProvider>
);
