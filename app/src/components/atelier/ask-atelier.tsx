/**
 * ASK ATELIER — the question box, on every page.
 *
 * WHY IT EXISTS
 *
 * Atelier's central claim is that neither side has to trust the other, and that
 * claim rests entirely on a mechanism: money leaves the client's wallet up
 * front, cannot be spent on anything else, and cannot be pulled back once
 * somebody starts. Nobody believes that from a tagline. They believe it when
 * they can ask "can he take it back?" and get a straight answer.
 *
 * So this is aimed at the question people actually have, which is almost never
 * "how do I use this" and almost always "what stops the other side doing
 * something to me".
 *
 * It answers; it never acts. There is no path from this panel to a transaction,
 * deliberately — a box anybody can type into must not be able to move money,
 * and saying so is easier than defending it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MessageCircle, X, ArrowUp, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "react-router-dom";
import {
  askAtelier,
  AssistantBusy,
  AUTOPILOT_CONFIGURED,
  type AskTurn,
  type AskViewer,
} from "@/lib/atelier/agent-api";

/** What the page is called, so "here" means something to the assistant. */
const PAGE_NAMES: Record<string, string> = {
  "/jobs": "Browse Jobs",
  "/post": "Post a Job",
  "/my-jobs": "My Jobs",
  "/get-hired": "My Work",
  "/analytics": "Analytics",
  "/": "home",
};

/**
 * Openers, chosen to be the things people are actually nervous about rather
 * than the things a product tour would cover.
 */
const OPENERS = [
  "Can the client take the money back once I start?",
  "What is Autopilot and what can't it do?",
  "How do I get paid if I have no crypto wallet?",
  "How does an AI agent decide who to hire?",
];

function Bubble({ turn }: { turn: AskTurn }) {
  const mine = turn.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          mine
            ? "bg-primary text-primary-foreground rounded-br-md shadow-sm"
            : "bg-muted/60 ring-1 ring-border/60 rounded-bl-md"
        }`}
      >
        {mine ? turn.content : <Answer text={turn.content} />}
      </div>
    </div>
  );
}

/**
 * Just enough markdown: bold, bullets, paragraphs.
 *
 * A full renderer would be a dependency and an XSS surface for text a language
 * model wrote. These three cover everything the assistant is told to produce,
 * and anything else renders as the plain text it already is.
 */
function Answer({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        const bulleted = lines.filter((l) => /^\s*[-*•]\s+/.test(l));

        if (bulleted.length > 0 && bulleted.length === lines.filter((l) => l.trim()).length) {
          return (
            <ul key={bi} className="space-y-1 pl-1">
              {bulleted.map((l, li) => (
                <li key={li} className="flex gap-2">
                  <span className="text-primary shrink-0" aria-hidden="true">•</span>
                  <span className="min-w-0">{bold(l.replace(/^\s*[-*•]\s+/, ""))}</span>
                </li>
              ))}
            </ul>
          );
        }
        return <p key={bi}>{bold(block)}</p>;
      })}
    </div>
  );
}

function bold(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function AskAtelier({ viewer }: { viewer?: AskViewer }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const location = useLocation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* Follow the conversation down, but only the conversation — scrolling the
     page under a floating panel is disorienting. */
  useEffect(() => {
    const el = scrollerRef.current;
    /* Guarded because scrollTo is not universal — jsdom has no implementation,
       and neither do some older mobile browsers. Falling back to the property
       still gets the reader to the newest message; failing would take the whole
       panel down with an exception. */
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns, thinking]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  /* Escape closes it. A panel that traps you is worse than no panel. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || thinking) return;

      const next: AskTurn[] = [...turns, { role: "user", content: text }];
      setTurns(next);
      setDraft("");
      setError(null);
      setThinking(true);

      try {
        const answer = await askAtelier(next, {
          ...viewer,
          page: PAGE_NAMES[location.pathname] ?? null,
        });
        setTurns((t) => [...t, { role: "assistant", content: answer }]);
      } catch (e) {
        setError(
          e instanceof AssistantBusy
            ? e.message
            : "I could not reach the assistant just now. Everything else on Atelier works normally.",
        );
      } finally {
        setThinking(false);
      }
    },
    [turns, thinking, viewer, location.pathname],
  );

  /* Nothing to open if there is no daemon to answer. */
  if (!AUTOPILOT_CONFIGURED) return null;

  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            {/*
              A scrim, so this reads as something on top of the page rather than
              part of it. The translucent panel it replaced sat directly on a
              dark background and the two dissolved into each other — you could
              not tell where the conversation ended and the job board began.
              Dimming what is behind it does the separating; clicking it is the
              obvious way out.
            */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setOpen(false)}
              aria-hidden="true"
              className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]"
            />

          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="Ask Atelier"
            /* Opaque, because a floating surface over arbitrary content has to
               be readable over all of it — that is what --popover is for. */
            className="fixed z-50 bg-popover text-popover-foreground rounded-2xl flex flex-col
                       ring-1 ring-border shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]
                       inset-x-3 bottom-3 top-20
                       sm:inset-x-auto sm:top-auto sm:right-5 sm:bottom-24
                       sm:w-[30rem] sm:h-[36rem] sm:max-h-[calc(100vh-9rem)]"
          >
            <header className="flex items-center justify-between gap-2 px-5 py-4 border-b shrink-0 rounded-t-2xl bg-gradient-to-b from-primary/[0.07] to-transparent">
              <div className="flex items-center gap-3 min-w-0">
                <span className="h-9 w-9 rounded-full bg-primary/12 ring-1 ring-primary/25 flex items-center justify-center shrink-0">
                  <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <div className="font-display font-semibold leading-none">Ask Atelier</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    How it works, and what protects you
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </header>

            <div ref={scrollerRef} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
              {turns.length === 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Ask me anything about how Atelier works — escrow, Autopilot,
                    getting paid. I can explain and point you at the right page,
                    but I can't move money or act on a job.
                  </p>
                  <div className="space-y-2">
                    {OPENERS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => void send(q)}
                        className="group w-full text-left text-sm rounded-xl border border-border/70 px-3.5 py-2.5
                                   hover:border-primary/40 hover:bg-primary/[0.06] transition-colors
                                   flex items-center justify-between gap-3"
                      >
                        <span className="min-w-0">{q}</span>
                        <ArrowUp className="h-3.5 w-3.5 shrink-0 rotate-45 text-muted-foreground group-hover:text-primary transition-colors" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {turns.map((t, i) => <Bubble key={i} turn={t} />)}

              {thinking && (
                <div className="flex justify-start">
                  <div className="glass rounded-2xl rounded-bl-sm px-3.5 py-3">
                    <span className="flex gap-1" aria-label="Thinking">
                      {[0, 1, 2].map((d) => (
                        <motion.span
                          key={d}
                          className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 1.1, repeat: Infinity, delay: d * 0.18 }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              )}

              {error && (
                <p className="text-xs text-muted-foreground border border-dashed rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
            </div>

            <form
              className="p-3 border-t shrink-0 flex items-end gap-2 rounded-b-2xl"
              onSubmit={(e) => { e.preventDefault(); void send(draft); }}
            >
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  /* Enter sends, Shift+Enter breaks the line — what everybody
                     already expects from a chat box. */
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder="Ask about escrow, Autopilot, getting paid…"
                aria-label="Your question"
                className="flex-1 resize-none bg-transparent text-sm outline-none max-h-28 py-2 px-2 placeholder:text-muted-foreground/70"
              />
              <Button
                type="submit"
                size="icon"
                disabled={thinking || draft.trim().length === 0}
                aria-label="Send"
                className="shrink-0"
              >
                {thinking
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <ArrowUp className="h-4 w-4" aria-hidden="true" />}
              </Button>
            </form>
          </motion.div>
          </>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close Atelier assistant" : "Ask Atelier a question"}
        aria-expanded={open}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="fixed z-50 bottom-5 right-5 h-12 w-12 rounded-full bg-primary text-primary-foreground
                   shadow-lg flex items-center justify-center"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? "close" : "open"}
            initial={{ opacity: 0, rotate: -30 }}
            animate={{ opacity: 1, rotate: 0 }}
            exit={{ opacity: 0, rotate: 30 }}
            transition={{ duration: 0.15 }}
          >
            {open
              ? <X className="h-5 w-5" aria-hidden="true" />
              : <MessageCircle className="h-5 w-5" aria-hidden="true" />}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </>
  );
}
