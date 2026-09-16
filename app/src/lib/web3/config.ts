export {
  CONTRACTS,
  getCurrentNetwork,
  ARC_NETWORKS,
} from "./chain-config";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ARC_TESTNET = {
  chainId: 421614,
  chainName: "Arbitrum Sepolia",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
  blockExplorerUrls: ["https://sepolia.arbiscan.io"],
};
