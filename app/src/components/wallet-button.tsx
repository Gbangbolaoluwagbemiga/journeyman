/**
 * The wallet control.
 *
 * This used to be a hand-built dropdown: copy address, refresh balance,
 * disconnect. Reown's AppKit is already initialised for connecting, and its
 * account modal does all three plus network switching, balance, transaction
 * history and the wallet's own branding — so the custom menu was a worse copy of
 * something already paid for, and one that had to be maintained separately every
 * time the wallet layer changed.
 *
 * Now the button is just a button. Reown owns everything behind it.
 *
 * What is kept is the trigger's own content, because that is the piece Reown
 * does not render for you, and a wallet control that shows nothing until you
 * click it makes people click it to check they are still connected.
 *
 * WHAT IT SHOWS, AND WHAT IT STOPPED SHOWING
 *
 * It used to carry five things: a network icon, the balance, the word USDC, a
 * separator, an identicon and a truncated address. Around 310px of a header
 * that also holds a theme toggle, a message icon and a bell — enough to push
 * the nav off centre and make the whole bar look mis-assembled.
 *
 * Two of them earn their place. The identicon IS the address — it is derived
 * from it, so it changes the moment you switch accounts, and two accounts are
 * quicker to tell apart by colour than by comparing 0x3Be7…8E41 against
 * 0x8289…c423. The balance is the number people actually glance up to check.
 *
 * The rest went: the network icon, because this app speaks to one chain and a
 * chain badge is noise until there are two; the word USDC, because Arc's native
 * currency is USDC and "$" says it in one character; and the truncated address,
 * because Reown's account modal already shows it in full with a copy button,
 * one click behind this. It stays in the tooltip and the accessible name, so
 * nobody who needs it has to go looking.
 *
 * ~110px, and the connected state still reads at a glance.
 */

import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/contexts/web3-context";
import { useState } from "react";
import { useAppKit } from "@reown/appkit/react";
import { useManagedWorker } from "@/hooks/use-managed-worker";
import { ManagedWalletMenu } from "@/components/atelier/managed-wallet-menu";

export function WalletButton() {
  const { wallet, connectWallet } = useWeb3();
  const [walletIconError, setWalletIconError] = useState(false);
  const { open } = useAppKit();
  const {
    worker: managedWorker,
    refresh: refreshWorker,
    refreshing: refreshingWorker,
  } = useManagedWorker();

  /*
   * A managed worker is signed in without a wallet, and telling them to
   * "Connect Wallet" is both wrong and slightly insulting — the entire point of
   * their account is that they never had to. They get their own menu, with the
   * same affordances Reown gives a wallet user: full address, copy, refresh,
   * explorer, sign out.
   */
  if (!wallet.isConnected || !wallet.address) {
    if (managedWorker) {
      return (
        <ManagedWalletMenu
          worker={managedWorker}
          onRefresh={() => void refreshWorker()}
          refreshing={refreshingWorker}
          onSignOut={() => window.location.assign("/get-hired")}
        />
      );
    }

    return (
      <Button onClick={() => void connectWallet()} variant="default">
        <span className="hidden sm:inline">Connect Wallet</span>
        <span className="sm:hidden">Connect</span>
      </Button>
    );
  }

  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  const balance = Number(wallet.balance || 0).toFixed(2);

  return (
    <Button
      variant="secondary"
      onClick={() => void open({ view: "Account" })}
      title={wallet.address}
      aria-label={`Wallet ${short}, ${balance} USDC — open account`}
      className="font-mono flex items-center gap-2 px-2.5 sm:px-3 bg-muted/50 hover:bg-muted/70 border border-border/40"
    >
      {/* The identicon is the identity: derived from the address, so it changes
          the instant you switch accounts. */}
      <span className="w-5 h-5 rounded-full overflow-hidden shrink-0">
        {!walletIconError ? (
          <img
            src={`https://effigy.im/a/${wallet.address}.svg`}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover"
            onError={() => setWalletIconError(true)}
          />
        ) : (
          <span className="block w-full h-full bg-gradient-to-br from-primary to-accent rounded-full" />
        )}
      </span>

      {/* Hidden on the narrowest screens, where the icon alone says connected
          and the header has a menu button to fit beside. */}
      <span className="hidden sm:inline tabular-nums">${balance}</span>
    </Button>
  );
}
