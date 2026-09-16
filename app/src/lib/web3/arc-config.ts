const ARC_TESTNET_CHAIN_ID = 5042002;

export const ARC_NETWORKS = {
  testnet: {
    chainId: ARC_TESTNET_CHAIN_ID,
    name: "Arc Testnet",
    rpcUrl: "https://rpc.drpc.testnet.arc.network",
    blockExplorer: "https://testnet.arcscan.app",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  },
} as const;

export function getCurrentNetwork() {
  return ARC_NETWORKS.testnet;
}

export const CONTRACTS = {
  ATELIER_ESCROW: (
    /* The old VITE_SECUREFLOW_* name is still read as a fallback. A deployment
       that already has it set should not break the moment the constant is
       renamed in source — the value is the same address either way. */
    import.meta.env.VITE_ATELIER_CONTRACT_ADDRESS ??
    import.meta.env.VITE_SECUREFLOW_CONTRACT_ADDRESS ??
    ""
  ).trim() as `0x${string}` | "",

  TRUSTED_FORWARDER: (
    import.meta.env.VITE_TRUSTED_FORWARDER_ADDRESS ?? ""
  ).trim() as `0x${string}` | "",

  /** MockUSDC on Arc Testnet (6 decimals). Empty = use native USDC. */
  USDC: (
    import.meta.env.VITE_USDC_TOKEN_CONTRACT ?? ""
  ).trim() as `0x${string}` | "",
} as const;
