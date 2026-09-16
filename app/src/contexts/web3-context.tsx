import { createContext, useContext, useState, type ReactNode } from "react";
import { useAccount, useDisconnect, useBalance } from "wagmi";
import { getContract as getViemContract } from "viem";
import { useWalletClient, usePublicClient } from "wagmi";
import { useAppKit } from "@reown/appkit/react";

interface Web3ContextType {
  wallet: {
    address: string | null;
    isConnected: boolean;
    balance: string;
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
  const { data: balanceData, refetch: refetchBalance } = useBalance({
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
    await refetchBalance();
  };

  return (
    <Web3Context.Provider
      value={{
        wallet: {
          address: address || null,
          isConnected,
          balance: balanceData
            ? (Number(balanceData.value) / 1e18).toFixed(2)
            : "0",
          chainId,
        },
        connectWallet,
        disconnectWallet,
        getContract,
        network: { rpcUrl: "https://rpc.drpc.testnet.arc.network" },
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
