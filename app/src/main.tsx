import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { WalletProvider } from "./providers/WalletProvider.tsx";
import { Web3Provider } from "./contexts/web3-context";
import { DelegationProvider } from "./contexts/delegation-context";
import { NotificationProvider as AtelierNotificationProvider } from "./contexts/notification-context";
import { ThemeProvider } from "./components/theme-provider";
import { BrowserRouter } from "react-router-dom";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      {/* WalletProvider sets up WagmiProvider + QueryClientProvider + Reown AppKit */}
      <WalletProvider>
        <Web3Provider>
          <DelegationProvider>
            <AtelierNotificationProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </AtelierNotificationProvider>
          </DelegationProvider>
        </Web3Provider>
      </WalletProvider>
    </ThemeProvider>
  </StrictMode>
);
