export {
  CONTRACTS,
  getCurrentNetwork,
  NETWORKS,
} from "./chain-config";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ARBITRUM_SEPOLIA = {
  chainId: 421614,
  chainName: "Arbitrum Sepolia",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
  blockExplorerUrls: ["https://sepolia.arbiscan.io"],
};
