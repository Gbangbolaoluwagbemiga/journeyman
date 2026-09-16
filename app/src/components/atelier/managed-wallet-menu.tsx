/**
 * The wallet menu for someone signed in with a managed Circle wallet.
 *
 * A wallet user gets Reown's account modal — address, balance, copy, network,
 * disconnect. A managed worker got a button that did nothing when clicked,
 * which is worse than no button: it looks broken rather than absent.
 *
 * This is the same set of affordances, for an account whose keys we hold. The
 * one addition is that it keeps saying so, because the address in here is not
 * one the person can import into a wallet app and control.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ExternalLink, KeyRound, LogOut, RefreshCw, Wallet } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { forgetWorker, linkOwnWallet, type Worker } from "@/lib/atelier/worker";
import { useWeb3 } from "@/contexts/web3-context";
import { toastError } from "@/lib/atelier/errors";

const EXPLORER = (
  (import.meta.env.VITE_ARC_EXPLORER_URL as string | undefined) ??
  "https://testnet.arcscan.app"
)
  .trim()
  .replace(/\/$/, "");

export function ManagedWalletMenu({
  worker,
  onRefresh,
  refreshing,
  onSignOut,
}: {
  worker: Worker;
  onRefresh: () => void;
  refreshing: boolean;
  onSignOut: () => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [linking, setLinking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const { wallet, connectWallet } = useWeb3();
  const connectedAddress = wallet.isConnected ? wallet.address : null;

  /**
   * Hand this account its own keys.
   *
   * Connecting comes first when there is nothing connected — asking somebody to
   * type an address is how a balance ends up swept to a typo that is still a
   * valid address, and no validation can catch that one.
   */
  async function graduate() {
    if (!connectedAddress) {
      await connectWallet();
      return;
    }
    setSwitching(true);
    try {
      await linkOwnWallet({ workerId: worker.id, address: connectedAddress });
      toast({
        title: "This account is yours now",
        description:
          "Your history came with you and anything held for you was sent across. You sign for yourself from here.",
      });
      setLinking(false);
      onRefresh();
    } catch (e) {
      toast(toastError("Could not switch to your wallet", e));
    } finally {
      setSwitching(false);
    }
  }

  /**
   * `balance` is null when the daemon could not read it — an RPC hiccup, not a
   * zero balance. Rendering that as "0.00" showed a wrong number as though it
   * were right, which for somebody looking at their earnings is the worst
   * possible failure mode. A dash says "unknown" and a refresh fixes it.
   */
  const known = worker.balance !== null && worker.balance !== undefined;
  const balance = known ? Number(worker.balance).toFixed(2) : "—";

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(worker.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: "Address copied", description: worker.address });
    } catch {
      // Clipboard is blocked in some contexts; the full address is on screen
      // in the menu, so there is still a way to get it.
      toast({
        variant: "destructive",
        title: "Could not copy",
        description: "Select the address above and copy it manually.",
      });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          title={worker.address}
          aria-label={`${worker.handle}, ${known ? `${balance} USDC` : "balance unavailable"} — open wallet menu`}
          /*
           * The same shape as the connected-wallet button, for the same reason:
           * it was carrying a balance, the word USDC, a separator and a
           * truncated address, and between them they unbalanced a header that
           * also holds a theme toggle, a message icon and a bell.
           *
           * The dot and the handle are what a managed worker needs here — the
           * dot marks them as the human actor, the handle is how they think of
           * themselves, and it distinguishes two Google accounts far better
           * than two truncated hex strings do. The full address is in the menu
           * one click away, selectable, which is where somebody who wants to
           * read an address goes anyway.
           */
          className="actor-human flex items-center gap-2 px-2.5 sm:px-3 bg-muted/50 hover:bg-muted/70 border border-border/40 max-w-[150px]"
        >
          <span className="actor-dot shrink-0" aria-hidden="true" />
          <span className="truncate">{worker.handle}</span>
          {/* A dash, not "$—": the balance is unknown, and a currency symbol in
              front of nothing reads like a number that failed to render. */}
          <span className="hidden sm:inline tabular-nums text-muted-foreground font-mono">
            {known ? `$${balance}` : "—"}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <div className="px-2 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
            {worker.handle}
          </div>
          {/* The full address, selectable. Truncation is for the button, not
              for the place someone came to read it. */}
          <div className="text-[11px] text-muted-foreground font-mono break-all mt-1.5 select-all">
            {worker.address}
          </div>
          <div className="text-xs text-muted-foreground mt-2">
            {known ? (
              <>
                Balance:{" "}
                <span className="tabular-nums text-foreground">{balance} USDC</span>
              </>
            ) : (
              "Balance unavailable — try refreshing."
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1.5">
            Held for you. We control the keys to this one.
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => void copyAddress()}>
          {copied ? (
            <Check className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={(e) => {
            // Keep the menu open so the new balance is visible where it changed.
            e.preventDefault();
            onRefresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {refreshing ? "Refreshing…" : "Refresh balance"}
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href={`${EXPLORER}/address/${worker.address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
            View on explorer
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <Link to="/get-hired">
            <Wallet className="mr-2 h-4 w-4" aria-hidden="true" />
            My work and earnings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/*
          GRADUATION TO SELF-CUSTODY.
          The daemon has had this since the Telegram bot's /link, and the client
          function has been exported this whole time with nothing calling it —
          so the honest answer to "how do I stop you holding my keys" was "you
          cannot, from here". The trade is stated on every screen that mentions
          this wallet; the way out of it should not be the one thing missing.

          It is not a plain menu item because it MOVES MONEY: the switch sweeps
          this wallet to the new address first, or the balance is stranded in a
          wallet nobody is using any more. Somebody should read that sentence
          before it happens, not after.
        */}
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault();
            setLinking(true);
          }}
        >
          <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
          Use my own wallet
        </DropdownMenuItem>

        {linking && (
          <div className="px-2 py-2 border-t border-border/40 mt-1">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {connectedAddress ? (
                <>
                  Your history moves to{" "}
                  <span className="font-mono text-foreground">
                    {connectedAddress.slice(0, 6)}…{connectedAddress.slice(-4)}
                  </span>
                  , and anything in this wallet is sent there first. Atelier
                  stops signing for you — you sign for yourself from then on.
                </>
              ) : (
                <>
                  Connect the wallet you want to use first. Your history and
                  your balance follow it, and Atelier stops holding keys for
                  you.
                </>
              )}
            </p>
            <div className="flex gap-2 mt-2">
              <Button
                size="sm"
                className="h-7 text-xs flex-1"
                disabled={switching}
                onClick={() => void graduate()}
              >
                {switching
                  ? "Switching…"
                  : connectedAddress
                    ? "Switch to it"
                    : "Connect a wallet"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setLinking(false)}
                disabled={switching}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="text-destructive"
          onClick={() => {
            forgetWorker();
            onSignOut();
          }}
        >
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
