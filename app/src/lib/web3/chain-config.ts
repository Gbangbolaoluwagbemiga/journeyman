const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

export const NETWORKS = {
  testnet: {
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    name: "Arbitrum Sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    blockExplorer: "https://sepolia.arbiscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
} as const;

export function getCurrentNetwork() {
  return NETWORKS.testnet;
}

export const CONTRACTS = {
  JOURNEYMAN_ESCROW: (
    /* The old VITE_SECUREFLOW_* name is still read as a fallback. A deployment
       that already has it set should not break the moment the constant is
       renamed in source — the value is the same address either way. */
    import.meta.env.VITE_JOURNEYMAN_CONTRACT_ADDRESS ??
    import.meta.env.VITE_SECUREFLOW_CONTRACT_ADDRESS ??
    ""
  ).trim() as `0x${string}` | "",

  TRUSTED_FORWARDER: (
    import.meta.env.VITE_TRUSTED_FORWARDER_ADDRESS ?? ""
  ).trim() as `0x${string}` | "",

  /** USDC on Arbitrum Sepolia (6 decimals), the Circle faucet token. */
  USDC: (
    import.meta.env.VITE_USDC_TOKEN_CONTRACT ?? ""
  ).trim() as `0x${string}` | "",
} as const;
