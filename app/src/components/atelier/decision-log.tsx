/**
 * THE DECISION LOG.
 *
 * The Ledger is the best-looking screen in the product, and the
 * reason is not the palette — it is the marginalia layout. Time and actor sit
 * in a narrow left column; the reasoning gets the main column and room to be a
 * paragraph. It reads as a *record* rather than a feed, which is the right
 * register for something a client may later need to argue with.
 *
 * That register is the point. When an agent spends someone else's money, "it
 * approved the work" is not enough — the client needs to see what it thought it
 * was looking at, in its own words, timestamped, in an order they can follow.
 * A notification stream cannot be audited. A log can.
 *
 * Colour carries the authorship, per `styles/atelier.css`: amber rows are the
 * agent's calls, teal rows are a person's. On an escalated job the trail turns
 * teal partway down and stays teal — the visual record of the machine handing
 * control back, which is the most reassuring thing on the page and needs no
 * caption.
 */

import { motion } from "framer-motion";
import { ExternalLink } from "lucide-react";
import { actorClass, ACTOR_LABEL, type Decision } from "@/lib/atelier/actor";

const EXPLORER = (
  (import.meta.env.VITE_ARC_EXPLORER_URL as string | undefined) ??
  "https://testnet.arcscan.app"
)
  .trim()
  .replace(/\/$/, "");

function timeOf(at: number): { clock: string; date: string; iso: string } {
  const d = new Date(at);
  return {
    clock: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString([], { month: "short", day: "numeric" }),
    iso: d.toISOString(),
  };
}

function DecisionEntry({ d, index }: { d: Decision; index: number }) {
  const t = timeOf(d.at);

  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      /* Capped so a log of eighty entries does not take eight seconds to
         finish arriving — the first few stagger, the rest are simply there. */
      transition={{ duration: 0.25, delay: Math.min(index * 0.03, 0.3) }}
      className={`${actorClass(d.by)} marginalia py-5 border-b border-border/40 last:border-b-0`}
    >
      <div className="marginalia-aside flex md:flex-col gap-2 md:gap-1 items-baseline md:items-start">
        <time dateTime={t.iso} className="tabular-nums">
          {t.clock}
        </time>
        <span className="opacity-60">{t.date}</span>
        <span className="actor-chip mt-0 md:mt-1.5">
          <span className="actor-dot" />
          {ACTOR_LABEL[d.by]}
        </span>
      </div>

      <div className="actor-rule min-w-0">
        <h3 className="font-medium leading-snug">{d.action}</h3>

        {d.rationale && (
          /* The agent's own words, unedited. Summarising them here would
             defeat the purpose — the client is checking the reasoning, not
             being reassured about it. */
          <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed whitespace-pre-line">
            {d.rationale}
          </p>
        )}

        {(d.amountUsdc || d.txHash) && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
            {d.amountUsdc && (
              <span className="actor-figure figure-md">
                ${d.amountUsdc}
                <span className="text-xs font-sans font-medium text-muted-foreground ml-1.5">
                  USDC
                </span>
              </span>
            )}
            {d.txHash && (
              <a
                href={`${EXPLORER}/tx/${d.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:actor-text transition-colors"
              >
                {d.txHash.slice(0, 10)}…{d.txHash.slice(-6)}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>
    </motion.li>
  );
}

export function DecisionLog({
  decisions,
  emptyMessage = "Nothing yet. Autopilot writes here as it works.",
}: {
  decisions: Decision[];
  emptyMessage?: string;
}) {
  if (decisions.length === 0) {
    return (
      <div className="rounded-2xl glass p-10 text-center">
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ol className="rounded-2xl glass px-5 sm:px-7 divide-y-0">
      {decisions.map((d, i) => (
        <DecisionEntry key={d.id} d={d} index={i} />
      ))}
    </ol>
  );
}
