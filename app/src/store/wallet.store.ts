import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type State = {
  address: string;
  network: "testnet" | "mainnet" | "local" | "";
  walletType: string;
  isConnected: boolean;
  publicKey: string;
  balance: string;
};

interface WalletStore extends State {
  connectWalletStore: (
    address: string,
    network: "testnet" | "mainnet" | "local",
    walletType: string,
    publicKey: string
  ) => void;
  disconnectWalletStore: () => void;
  updateConnectionStatus: (isConnected: boolean) => void;
  updateBalance: (balance: string) => void;
}

const useWalletStore = create<WalletStore>()(
  persist(
    (set) => ({
      address: "",
      network: "",
      walletType: "",
      isConnected: false,
      publicKey: "",
      balance: "0",
      connectWalletStore: (
        address: string,
        network: "testnet" | "mainnet" | "local",
        walletType: string,
        publicKey: string
      ) =>
        set({
          address,
          network,
          walletType,
          publicKey,
          isConnected: true,
        }),
      disconnectWalletStore: () =>
        set({
          address: "",
          network: "",
          walletType: "",
          publicKey: "",
          isConnected: false,
          balance: "0",
        }),
      updateConnectionStatus: (isConnected: boolean) => set({ isConnected }),
      updateBalance: (balance: string) => set({ balance }),
    }),
    {
      name: "wallet-storage",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

export default useWalletStore;
