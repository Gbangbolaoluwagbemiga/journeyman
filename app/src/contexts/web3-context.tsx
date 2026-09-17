import { createContext, useContext, useState, type ReactNode } from "react";
import { useAccount, useDisconnect, useBalance, useReadContracts } from "wagmi";
import { getContract as getViemContract, formatUnits, erc20Abi } from "viem";
import { useWalletClient, usePublicClient } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { CONTRACTS } from "@/lib/web3/chain-config";

interface Web3ContextType {
  wallet: {
    address: string | null;
    isConnected: boolean;
    /** USDC — what jobs are priced and paid in. This is "do they have money". */
    balance: string;
    /** ETH — what transactions cost. This is "can they sign". */
    gasBalance: string;
    chainId?: number;
  };
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  getContract: (address: string, abi?: any) => any;
  network: any;
  refreshBalance: () => Promise<void>;
  isOwner: boolean;
}

const Web3Context = createContext<Web3ContextType | undefined>(undefined);

export function Web3Provider({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  /*
   * Polled as well as refetched on focus.
   *
   * A withdrawal or an escrow funding changes this number without the browser
   * doing anything, and the header is where people look to confirm it happened.
   * Fifteen seconds is slow enough to be invisible against one balance read and
   * fast enough that nobody reaches for the reload button.
   */
  /*
   * TWO BALANCES, BECAUSE THIS CHAIN HAS TWO ASSETS.
   *
   * There was one read here, with no `token`, so it returned the NATIVE
   * currency — and every caller labelled it USDC. That was correct on the chain
   * this was built for, where the native currency WAS USDC. On Arbitrum the
   * native currency is ETH, so the header advertised a gas balance in dollars
   * and Create Job refused to post a 5 USDC brief from a wallet holding 500
   * USDC, on the grounds that it only had 0.03 — of something else.
   */
  const { data: usdcData, refetch: refetchUsdc } = useReadContracts({
    contracts: [
      { address: CONTRACTS.USDC, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0"] },
      { address: CONTRACTS.USDC, abi: erc20Abi, functionName: "decimals" },
    ],
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const { data: gasData, refetch: refetchGas } = useBalance({
    address,
    query: { refetchInterval: 15_000 },
  });
  const { open } = useAppKit();

  const [isOwner] = useState(false);

  const getContract = (contractAddress: string, abi?: any) => {
    if (!contractAddress || !abi || !publicClient) return null;
    return getViemContract({
      address: contractAddress as `0x${string}`,
      abi,
      client: { public: publicClient, wallet: walletClient },
    });
  };

  const connectWallet = async () => {
    // Opens the Reown AppKit modal — supports MetaMask, WalletConnect, Coinbase, etc.
    await open();
  };

  const disconnectWallet = () => disconnect();

  const refreshBalance = async () => {
    await Promise.all([refetchUsdc(), refetchGas()]);
  };

  return (
    <Web3Context.Provider
      value={{
        wallet: {
          address: address || null,
          isConnected,
          /* formatUnits off the token's own decimals rather than a hardcoded
             divisor: USDC is 6 here and was 18 as a native currency, and that
             one constant is the difference between $5 and $0.000000000000005. */
          balance:
            usdcData?.[0]?.status === "success" && usdcData?.[1]?.status === "success"
              ? formatUnits(usdcData[0].result as bigint, usdcData[1].result as number)
              : "0",
          gasBalance: gasData ? formatUnits(gasData.value, gasData.decimals) : "0",
          chainId,
        },
        connectWallet,
        disconnectWallet,
        getContract,
        network: { rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc" },
        refreshBalance,
        isOwner,
      }}
    >
      {children}
    </Web3Context.Provider>
  );
}

export function useWeb3() {
  const context = useContext(Web3Context);
  if (context === undefined) {
    throw new Error("useWeb3 must be used within a Web3Provider");
  }
  return context;
}
