export {
  CONTRACTS,
  getCurrentNetwork,
  ARC_NETWORKS,
} from "./arc-config";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ARC_TESTNET = {
  chainId: 5042002,
  chainName: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: ["https://rpc.drpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};
