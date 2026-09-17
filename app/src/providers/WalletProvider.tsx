import React from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "viem";
import type { AppKitNetwork } from "@reown/appkit/networks";

// ─── Arbitrum Sepolia — defined as a viem Chain ───────────────────────────────
export const arbitrumSepolia = defineChain({
  id: 421614,
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] },
  },
  blockExplorers: {
    default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" },
  },
  /*
   * MULTICALL3, DECLARED ON PURPOSE.
   *
   * viem will not use a contract the chain has not declared, and the failure is
   * silent: `client.multicall(...)` throws ChainDoesNotSupportContract and every
   * call site falls into its fallback, which in this app is the sequential loop
   * the batch existed to replace. On the previous chain that went unnoticed for weeks —
   * escrows, milestones, the analytics page and the autopilot badge all doing
   * one request per item while the comments around them explained why they
   * didn't. Nothing looked broken, because the fallbacks worked.
   *
   * Confirmed deployed on both Arbitrum One and Sepolia before declaring it.
   */
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

// Cast to Reown's AppKitNetwork so it works with createAppKit and WagmiAdapter
const arbitrumSepoliaReown = arbitrumSepolia as unknown as AppKitNetwork;

const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ?? "";

// ─── Wagmi adapter (Reown manages connectors: MetaMask, WC QR, Coinbase, etc.)
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [arbitrumSepoliaReown],
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

// ─── Reown AppKit initialisation ──────────────────────────────────────────────
createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [arbitrumSepoliaReown],
  defaultNetwork: arbitrumSepoliaReown,
  metadata: {
    name: "Journeyman",
    description: "Milestone-based freelancer escrow on Arbitrum",
    url: typeof window !== "undefined" ? window.location.origin : "https://journeyman.app",
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
