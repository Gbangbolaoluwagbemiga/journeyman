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

/**
 * The block the proxy was deployed at.
 *
 * Anything that walks logs needs a floor, and the alternative — a fixed number
 * of blocks back from the head — is a duration in disguise. It was 9,000 blocks
 * in one place, which was a comfortable hour on the old chain and thirty-seven
 * minutes here.
 */
export const DEPLOY_BLOCK = 309527684n;

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

  /**
   * USDC on Arbitrum Sepolia (6 decimals), the Circle faucet token.
   *
   * Defaulted, not left blank. An unset VITE_USDC_TOKEN_CONTRACT does not fail
   * anywhere — it makes the app fall back to whatever a caller uses for "no
   * token", which means reading an ETH balance as if it were dollars and
   * funding escrows with an address that has no code. A wrong build should be
   * a wrong build, not a subtly wrong product.
   */
  USDC: (
    import.meta.env.VITE_USDC_TOKEN_CONTRACT ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
  ).trim() as `0x${string}`,
} as const;
