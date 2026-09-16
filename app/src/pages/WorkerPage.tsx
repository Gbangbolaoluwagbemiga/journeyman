/**
 * GET HIRED — the door for someone with no wallet.
 *
 * Atelier has two entrances and they are not the same product surface. The main
 * app assumes a connected wallet: you sign your own transactions, you hold your
 * own keys, and everything is on-chain from your address. This page assumes
 * none of that.
 *
 * It exists because the supply side was the harder problem. An agent can start
 * commissioning work with one HTTP call; a designer who has never used crypto
 * had eight steps and three foreign concepts to get through before earning a
 * first dollar. Most of them, reasonably, did not.
 *
 * Deliberately reachable WITHOUT connecting a wallet — that is the entire
 * point, so the route must never be put behind the wallet gate that protects
 * the client area.
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, LogOut, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkerJoin } from "@/components/atelier/worker-join";
import { WorkerBoard } from "@/components/atelier/worker-board";
import {
  WORKER_DOOR_OPEN,
  currentWorkerId,
  forgetWorker,
  rememberWorkerAddress,
  me as fetchMe,
  type Worker,
} from "@/lib/atelier/worker";

const TELEGRAM_BOT = (
  (import.meta.env.VITE_TELEGRAM_BOT as string | undefined) ?? ""
).trim();

export default function WorkerPage() {
  const [worker, setWorker] = useState<Worker | null>(null);

  /* One place that records who is signed in, so every path into a worker —
     resuming, joining, a board refresh — leaves the bell able to find them. */
  const adopt = useCallback((w: Worker) => {
    setWorker(w);
    if (w?.address) rememberWorkerAddress(w.address);
  }, []);
  const [checking, setChecking] = useState(true);

  /* Resume a session if this browser has one. A worker id is not a credential
     in any meaningful sense — it is a convenience so returning does not mean
     signing up twice — which is why losing it costs the UI and not the money. */
  const resume = useCallback(async () => {
    const id = currentWorkerId();
    if (!id) {
      setChecking(false);
      return;
    }
    try {
      const me = await fetchMe(id);
      setWorker(me);
      /* So the bell knows who this is. It keys off a connected wallet, and a
         managed worker never connects one. */
      if (me.address) rememberWorkerAddress(me.address);
    } catch {
      // The daemon no longer knows this id — a wiped dev database, usually.
      // Clear it rather than leaving someone stuck on a spinner forever.
      forgetWorker();
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void resume();
  }, [resume]);

  if (!WORKER_DOOR_OPEN) {
    return (
      <div className="container mx-auto px-4 py-24 max-w-lg text-center">
        <h1 className="font-display text-2xl font-bold">
          The worker service is not running
        </h1>
        <p className="text-muted-foreground mt-3">
          Set <code className="font-mono text-xs">VITE_AGENT_API_URL</code> to a
          running Atelier agent to open this door.
        </p>
      </div>
    );
  }

  if (checking) {
    return (
      <div className="container mx-auto px-4 py-24 flex justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10 sm:py-14 max-w-5xl">
      {worker ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
            <div>
              <span className="actor-chip actor-human">
                <span className="actor-dot" />
                {worker.mode === "managed" ? "Managed wallet" : "Your wallet"}
              </span>
              <h1 className="font-display text-3xl sm:text-4xl font-bold mt-3">
                {worker.handle}
              </h1>

              {/*
                WHICH ACCOUNT THIS IS.

                A handle is not an identity — two Google accounts can both be
                "cdev", and when they are, this page is identical between them
                apart from a truncated hex address. Signing in with the wrong
                one then looks exactly like the app having issued a new wallet
                and lost the job the other account was hired for. It has not;
                the other account still holds it. This is the line that says so.
              */}
              {worker.signedInAs && (
                <p className="text-sm text-muted-foreground mt-1.5">
                  Signed in as{" "}
                  <span className="text-foreground">{worker.signedInAs}</span>
                  {" · "}
                  <span className="font-mono text-xs">
                    {worker.address.slice(0, 6)}…{worker.address.slice(-4)}
                  </span>
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                forgetWorker();
                setWorker(null);
              }}
            >
              <LogOut className="h-4 w-4 mr-2" aria-hidden="true" />
              Sign out
            </Button>
          </div>

          <WorkerBoard worker={worker} onWorkerChanged={adopt} />

          <TelegramCard handle={worker.handle} />
        </>
      ) : (
        /*
          Two columns: why on the left, the form on the right.
          
          A signup with five fields does not need a full-width column, and
          stacking the pitch, the form, the custody note and the Telegram card
          in one made a short flow read as a long one — the button sat below the
          fold on a laptop, which is the worst place for the only thing anyone
          came here to press.
        */
        <div className="grid lg:grid-cols-[minmax(0,1fr)_26rem] gap-8 lg:gap-12 items-start">
          <div className="actor-human">
            <span className="actor-chip">
              <span className="actor-dot" />
              Get hired
            </span>

            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mt-4">
              Start earning in one step
            </h1>
            <p className="text-lg text-muted-foreground mt-4 leading-relaxed max-w-prose">
              No install, no seed phrase, no gas. Sign in, pick a name, and you
              are a freelancer who can apply to funded work and be paid in USDC.
            </p>

            <ol className="mt-8 space-y-5">
              {[
                [
                  "Sign in and pick a name",
                  "We create a wallet for you. Nothing to install, nothing to write down.",
                ],
                [
                  "Apply with a sentence",
                  "No gas and no signature — we sign on your instruction. An agent scores every applicant together when the window closes, so nobody wins by refreshing fastest.",
                ],
                [
                  "Deliver, and get paid in USDC",
                  "Payment is released from on-chain escrow the moment your work is approved. Withdraw to a wallet you own whenever you like.",
                ],
              ].map(([title, body], i) => (
                <li key={title} className="flex gap-4">
                  <span className="actor-figure figure-md shrink-0 w-7 tabular-nums">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium">{title}</div>
                    <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            {/* The custody trade-off, stated where there is room to state it
                properly rather than crammed beside the button. */}
            <div className="mt-8 rounded-xl border border-border/60 p-4 max-w-prose">
              <h2 className="font-medium text-sm">Who holds the keys</h2>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                The wallet we create is held by us, not you. That is the trade
                that removes the setup, and it is the reason we say it here
                rather than when you try to withdraw. Move your earnings to an
                address you control once you are paid — or bring your own wallet
                from the start and sign everything yourself.
              </p>
            </div>

            <div className="mt-6">
              <TelegramCard />
            </div>
          </div>

          <div className="lg:sticky lg:top-24">
            <WorkerJoin onJoined={adopt} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The second door, for people who would rather not keep a tab open.
 *
 * The Telegram bot is the same worker service underneath — join, browse, apply,
 * submit, withdraw — so someone can start here and continue there, or never
 * open this page at all. Shown even before signing up, because for a lot of
 * people it is the more natural way in.
 */
function TelegramCard({ handle }: { handle?: string }) {
  if (!TELEGRAM_BOT) return null;

  const url = `https://t.me/${TELEGRAM_BOT.replace(/^@/, "")}`;
  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, delay: 0.15 }}
      className="rounded-xl glass p-5 mt-10 flex flex-wrap items-center justify-between gap-4"
    >
      <div className="min-w-0">
        <h2 className="font-medium flex items-center gap-2">
          <Send className="h-4 w-4" aria-hidden="true" />
          Work from Telegram instead
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-prose">
          {handle
            ? "Same account, same wallet, same jobs — pushed to you instead of you checking. Send /link in the bot to connect this account."
            : "Browse and apply from a chat, with jobs pushed to you as they appear. No install beyond Telegram itself."}
        </p>
      </div>
      <Button asChild variant="outline" className="shrink-0">
        <a href={url} target="_blank" rel="noopener noreferrer">
          Open the bot
        </a>
      </Button>
    </motion.section>
  );
}
