/**
 * WHO IS RUNNING THIS JOB — and the one click that changes the answer.
 *
 * Shown to a client on their own job. Never to a freelancer: a worker must not
 * be able to tell whether their client is a person or an agent, and this
 * component would announce it in amber. `lib/atelier/actor.ts` explains why that
 * matters; the guard is that this is only mounted inside the client's own area.
 *
 * The design job here is to make handing over control feel reversible, because
 * it is. The revoke button is not hidden behind a confirmation or a settings
 * page — it sits next to the delegation, same size, always available. A client
 * who can see the exit is much more likely to try the thing at all.
 */

import { useState, useEffect, useCallback } from "react";
import { useSignMessage } from "wagmi";
import {
  fetchLimits,
  fetchHandoverPreview,
  fetchJobCriteria,
  handoverMessage,
  saveHandoverPrefs,
  type HandoverPreview,
} from "@/lib/atelier/agent-api";
import { motion } from "framer-motion";
import { Bot, Loader2, User, Clock, ListChecks, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useJobManager } from "@/hooks/use-job-manager";
import { useWeb3 } from "@/contexts/web3-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AUTOPILOT_CONFIGURED } from "@/lib/atelier/agent-api";
import { toastError } from "@/lib/atelier/errors";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * The acceptance criteria written into the escrow at funding time.
 *
 * A job posted through Autopilot puts them there; a job created by hand puts
 * only the client's free text. That difference decides whether the agent reads
 * back criteria the client approved or invents its own, so it has to be visible
 * before the client signs, not discovered afterwards.
 */
function criteriaIn(description: string | undefined): string[] {
  if (!description) return [];
  const marker = description.indexOf("Acceptance criteria:");
  if (marker === -1) return [];
  return description
    .slice(marker)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•"))
    .map((line) => line.replace(/^•\s*/, ""));
}

function humanMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The review windows worth offering, and why these.
 *
 * A fixed three minutes was the only answer the product had, which is right for
 * a demo and wrong for a real commission — nobody finds, reads and applies to a
 * job in three minutes. These span "I am showing someone this" to "give people
 * a proper chance", and the client picks once, at the moment they hand over.
 */
/** "30 minutes", "4 hours", "3 days" — whichever unit reads naturally. */
function describeWindow(minutes: number): string {
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  if (minutes < 1440) {
    const h = Math.round(minutes / 60);
    return h === 1 ? "an hour" : `${h} hours`;
  }
  const d = Math.round(minutes / 1440);
  return d === 1 ? "a day" : `${d} days`;
}

const WINDOW_CHOICES: { minutes: number; label: string; hint: string }[] = [
  { minutes: 3, label: "3 minutes", hint: "Demo pace — hires almost immediately" },
  { minutes: 30, label: "30 minutes", hint: "A quick job someone is waiting on" },
  { minutes: 240, label: "4 hours", hint: "Enough for a working afternoon" },
  { minutes: 1440, label: "24 hours", hint: "A real shot for people in other timezones" },
  { minutes: 4320, label: "3 days", hint: "Specialist work worth waiting for" },
];

export function AutopilotControl({
  escrowId,
  /** Hide entirely when the connected wallet is not this job's client. */
  isClient,
  projectDescription,
  milestones,
  /** The freelancer already on this job, if there is one. */
  assignedTo,
}: {
  escrowId: number;
  isClient: boolean;
  /** What is actually stored on-chain — the only thing the agent can read. */
  projectDescription?: string;
  milestones?: Array<{ description: string; amount: string }>;
  assignedTo?: string | null;
}) {
  /*
   * Read from the daemon, never assumed. The window is an environment variable
   * and a client can lengthen it per job, so a number typed into this file
   * would be right until the day it quietly was not.
   */
  const [windowMinutes, setWindowMinutes] = useState<number | null>(null);

  /*
   * Bumped after a hand-over, because the window is read once on mount and the
   * client has just changed it.
   *
   * Without this the card kept quoting whatever the window was when the page
   * loaded: somebody picked twenty-four hours, the toast said a day because it
   * reports what was saved, and the panel underneath went on promising four
   * hours from the delegation before. Two true-looking numbers about the same
   * job, and the wrong one is the one that stays on screen.
   */
  const [windowTick, setWindowTick] = useState(0);

  useEffect(() => {
    let live = true;

    /*
     * This job's window, not the deployment's.
     *
     * It read /api/limits, which is the global default — so a client who had
     * asked for a day still saw the card promise three minutes. The per-job
     * answer lives with the job's criteria; fall back to the default only when
     * the job has no answer of its own.
     */
    fetchJobCriteria(escrowId)
      .then((c) => { if (live) setWindowMinutes(c.applicationWindowMinutes ?? null); })
      .catch(() => {
        fetchLimits()
          .then((l) => { if (live) setWindowMinutes(l.applicationWindowMinutes ?? null); })
          .catch(() => {});
      });
    return () => { live = false; };
  }, [escrowId, windowTick]);

  const { manager, loaded, busy, delegate, revoke } = useJobManager(escrowId);
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const { signMessageAsync } = useSignMessage();
  const [pending, setPending] = useState<"delegate" | "revoke" | null>(null);
  const [confirming, setConfirming] = useState(false);

  /*
   * What the agent will actually judge by, generated from the escrow before the
   * client signs anything.
   *
   * The dialog used to say a hand-over "may judge against wording you have not
   * seen" — which was true, and is a strange thing to ask somebody to accept.
   * The criteria existed; adoptDelegated generated them the moment the
   * delegation landed. They were simply generated after the point of no return.
   */
  const [preview, setPreview] = useState<HandoverPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [chosenWindow, setChosenWindow] = useState<number | null>(null);

  const loadPreview = useCallback(() => {
    if (!AUTOPILOT_CONFIGURED) return;
    setPreviewError(null);
    setPreview(null);
    fetchHandoverPreview(escrowId)
      .then((p) => {
        setPreview(p);
        setChosenWindow((w) => w ?? p.applicationWindowMinutes);
      })
      .catch((e) => setPreviewError(humanMessage(e)));
  }, [escrowId]);

  /* Written into the escrow at funding time — the fallback when the daemon
     cannot be reached to generate anything. */
  /*
   * A job with somebody on it is past hiring.
   *
   * Autopilot on such a job reviews submissions and releases payment; it has
   * nobody left to choose. Asking the client how long to leave applications
   * open would be asking about a decision that has already been made, and the
   * card would go on promising a window that will never open.
   */
  const hasFreelancer =
    typeof assignedTo === "string" &&
    assignedTo !== "" &&
    !/^0x0+$/i.test(assignedTo);

  const storedCriteria = criteriaIn(projectDescription);
  const criteria = preview?.criteria.length ? preview.criteria : storedCriteria;

  // Below every hook, so the guard cannot change how many run.
  if (!isClient) return null;

  const onDelegate = async () => {
    setConfirming(false);
    setPending("delegate");
    try {
      await delegate();

      /*
       * Record the window and criteria only AFTER the delegation is mined.
       *
       * Doing it first would leave settings behind for a job that never got
       * handed over — if the client rejects the wallet prompt, or the
       * transaction reverts, the daemon would be holding instructions for a job
       * it does not manage.
       *
       * Deliberately not fatal. The hand-over itself is on-chain and already
       * succeeded; failing the whole action here would tell a client their
       * delegation did not work when it plainly did. They lose the custom
       * window, not the job, so say exactly that.
       */
      /*
       * The window is the client's choice, not a rider on the criteria.
       *
       * This required `preview !== null` — and the preview is a language-model
       * call that drafts acceptance criteria. When that failed, which it does
       * whenever the model is busy, the client's chosen window was silently
       * discarded and the job quietly ran on the three-minute default. They
       * were never told; the toast congratulated them on the four hours they
       * had picked.
       *
       * The two are independent. A window with no drafted criteria is still a
       * window somebody chose.
       */
      const defaultWindow = preview?.defaultWindowMinutes ?? windowMinutes;
      const wantsCustom =
        !hasFreelancer &&
        chosenWindow !== null &&
        defaultWindow !== null &&
        chosenWindow !== defaultWindow;

      let windowSaved = false;
      let windowProblem: string | null = null;

      if (wantsCustom && wallet.address) {
        try {
          const message = handoverMessage(wallet.address, escrowId, chosenWindow);
          const signature = await signMessageAsync({ message });
          await saveHandoverPrefs({
            escrowId,
            criteria: preview?.criteria ?? [],
            applicationWindowMinutes: chosenWindow,
            address: wallet.address,
            message,
            signature,
          });
          windowSaved = true;
        } catch (e) {
          windowProblem = humanMessage(e);
        }
      }

      /*
       * Report what happened, not what was asked for.
       *
       * The toast used to read the chosen window straight off the picker, so it
       * announced four hours whether or not anything had been recorded. A
       * confirmation that confirms your intention rather than the outcome is
       * worse than none: it is the reason nobody noticed.
       */
      const effective = windowSaved ? chosenWindow : defaultWindow;

      /* Show it immediately, then confirm from the daemon — the panel is about
         to re-render as "Autopilot is running this job" and quote a number. */
      if (effective !== null) setWindowMinutes(effective);
      setWindowTick((n) => n + 1);
      const windowLabel = effective !== null ? describeWindow(effective) : null;

      toast({
        title: "Autopilot is running this job",
        description: windowProblem
          ? `Your review window could not be saved (${windowProblem}), so it stays at ${windowLabel ?? "the default"}. Everything else is set — you can hand it over again to retry.`
          : (windowLabel ? `Applications stay open for ${windowLabel}. ` : "") +
            "It can hire, review and pay. It can never move your money elsewhere, and disputes stay yours.",
      });
    } catch (e) {
      toast(toastError("Could not hand over the job", e));
    } finally {
      setPending(null);
    }
  };

  /* Generate the criteria when the dialog opens, not on mount: it is an LLM
     call, and most viewings of this card never open the dialog at all. */
  const openHandover = () => {
    setConfirming(true);
    if (!preview) loadPreview();
  };

  const onRevoke = async () => {
    setPending("revoke");
    try {
      await revoke();
      toast({
        title: "You are running this job again",
        description: "Autopilot's next action on it will be rejected on-chain.",
      });
    } catch (e) {
      toast(toastError("Could not take back control", e));
    } finally {
      setPending(null);
    }
  };

  /* `manager === null` is a real answer, so it must not be rendered until we
     actually know — otherwise every Autopilot job flashes "managed by you"
     first, which is the one wrong thing to say about it. */
  if (!loaded) {
    return (
      <div className="rounded-xl glass p-4 flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking who manages this job…
      </div>
    );
  }

  const onAutopilot = manager !== null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`${onAutopilot ? "actor-agent" : "actor-human"} rounded-xl actor-panel p-4 sm:p-5`}
    >
      {/*
        Identity and action on one row; everything explanatory below it at full
        width.

        The button used to sit BESIDE the prose, which squeezed the paragraph
        into a narrow column and made the card grow tall enough to push the rest
        of the job off the screen. The text is the part that wants width.
      */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="actor-chip">
            <span className="actor-dot" />
            {onAutopilot ? "Autopilot" : "You"}
          </span>

          <h3 className="font-display text-lg font-semibold mt-2.5 actor-text">
            {onAutopilot ? "Autopilot is running this job" : "You are running this job"}
          </h3>
        </div>

        <Button
          variant={onAutopilot ? "outline" : "default"}
          size="sm"
          onClick={onAutopilot ? onRevoke : openHandover}
          disabled={busy || (!onAutopilot && !AUTOPILOT_CONFIGURED)}
          className={
            onAutopilot
              ? "shrink-0"
              : "shrink-0 bg-[var(--actor-agent)] text-[var(--actor-agent-fg)] hover:bg-[var(--actor-agent)] hover:opacity-90"
          }
        >
          {pending !== null && (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
          )}
          {pending === null &&
            (onAutopilot ? (
              <User className="h-4 w-4 mr-2" aria-hidden="true" />
            ) : (
              <Bot className="h-4 w-4 mr-2" aria-hidden="true" />
            ))}
          {onAutopilot ? "Take back control" : "Hand to Autopilot"}
        </Button>
      </div>

      <div>
          <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
            {onAutopilot ? (
              <>
                It briefs, hires, reviews and releases payment as{" "}
                <span className="font-mono text-xs">
                  {shortAddress(manager)}
                </span>
                . It cannot move your money anywhere else, and it cannot settle
                a dispute — if it runs out of revision rounds it hands the job
                to a human arbiter, exactly as you or the freelancer could.
                {/*
                  When it decides, which was nowhere on this screen.
                  A client handed a job over and had no idea whether hiring
                  happened in a second, an hour, or only once they asked.

                  It waits on purpose. Scoring the first application to arrive
                  would make this a race rather than a comparison, and the whole
                  claim is that applicants are read against each other.
                */}
                {windowMinutes !== null && !hasFreelancer && (
                  <>
                    {" "}It leaves applications open for{" "}
                    <strong className="text-foreground">
                      {describeWindow(windowMinutes)}
                    </strong>{" "}
                    and then reads them all together, rather than hiring
                    whoever happened to apply first. Anyone who applies after
                    that is still picked up on the next pass.
                  </>
                )}
              </>
            ) : (
              "You write the brief, choose the freelancer, and approve each milestone yourself."
            )}
          </p>
      </div>

      {!onAutopilot && !AUTOPILOT_CONFIGURED && (
        <p className="text-xs text-muted-foreground mt-3">
          Autopilot is not configured for this deployment.
        </p>
      )}

      {/*
        Show what the agent will actually work from, before the signature.
        Handing over is one transaction that names an address; everything the
        agent then does, it decides from what is already stored on-chain. A
        client who has not seen that is approving a standard they have not read.
      */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Hand this job to Autopilot?</AlertDialogTitle>
            <AlertDialogDescription>
              It will hire, review and release payment against what is written
              below — the only thing it can read. You keep the money, the dispute
              right, and the ability to take the job back at any moment.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 text-sm max-h-[45vh] overflow-y-auto">
            {milestones && milestones.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                  It pays out in these stages
                </div>
                <ul className="space-y-1">
                  {milestones.map((m, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="font-mono text-xs shrink-0 actor-text">
                        ${(Number(m.amount) / 1e6).toFixed(2)}
                      </span>
                      <span className="text-muted-foreground">{m.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                It approves or rejects against
              </div>

              {/*
                THE TITLE AND THE JOB DISAGREE.

                Raised rather than resolved, because only the client knows which
                they meant. A job titled "fireball" whose description asks for a
                Discord role to be removed was read as a vector illustration
                commission on one run and an account recovery job on another —
                and a freelancer's application scored 25 against one and 70
                against the other. The brief is now always written from the
                description; this is the client's chance to say that was wrong.
              */}
              {preview?.titleConflict && (
                <div className="mb-2 rounded-md border border-[var(--actor-agent)]/40 bg-[var(--actor-agent)]/10 px-3 py-2">
                  <div className="font-medium text-xs uppercase tracking-wide flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    Your title and your description ask for different things
                  </div>
                  <p className="text-muted-foreground mt-1">
                    {preview.titleConflict}
                  </p>
                  <p className="text-muted-foreground mt-1.5">
                    The criteria below were written from your description, not
                    your title. If that is the wrong way round, take the job back
                    and repost it — a freelancer will be judged against these.
                  </p>
                </div>
              )}

              {/*
                Generated from the escrow before the signature, not after it.

                This block used to say the agent "may judge against wording you
                have not seen" — accurate, and an odd thing to ask anyone to
                accept. The criteria were always written; they were just written
                on the far side of the point of no return. Now the same
                generator runs first, and what is on screen is what gets stored.
              */}
              {criteria.length > 0 ? (
                <>
                  <ul className="space-y-1 text-muted-foreground">
                    {criteria.map((c, i) => (
                      <li key={i}>• {c}</li>
                    ))}
                  </ul>
                  {preview?.criteria.length ? (
                    <p className="text-xs text-muted-foreground/80 mt-2">
                      Written by Autopilot from your title and description.
                      Freelancers see these on the job before they apply.
                    </p>
                  ) : null}
                </>
              ) : previewError ? (
                <p className="text-muted-foreground">
                  Autopilot could not be reached to draft criteria
                  ({previewError}). It will still work them out from your
                  description when it picks the job up.
                </p>
              ) : preview === null && AUTOPILOT_CONFIGURED ? (
                <p className="text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Autopilot is drafting the criteria for this job…
                </p>
              ) : (
                <p className="text-muted-foreground">
                  This job has no acceptance criteria written into it. The agent
                  will work them out from your description. You can take the job
                  back at any point.
                </p>
              )}
            </div>

            {/*
              HOW LONG APPLICATIONS STAY OPEN.

              Three minutes was hard-coded, which is a demo number: nobody finds,
              reads and applies to a real commission inside three minutes, so
              every job was effectively hired from whoever happened to be
              watching. The daemon already honoured a per-job window — the brief
              has carried the field all along — and nothing ever set it. This is
              the moment to ask, because it is the moment the client is deciding
              how much of the job to hand over.
            */}
            {hasFreelancer ? (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  It will not be hiring
                </div>
                <p className="text-muted-foreground">
                  This job already has a freelancer. Autopilot will review what
                  they submit and release each milestone against the criteria
                  above — it has nobody left to choose, so there is no
                  application window to set.
                </p>
              </div>
            ) : (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Leave applications open for
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {WINDOW_CHOICES.map((c) => {
                  const active = chosenWindow === c.minutes;
                  return (
                    <button
                      key={c.minutes}
                      type="button"
                      onClick={() => setChosenWindow(c.minutes)}
                      aria-pressed={active}
                      className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                        active
                          ? "border-[var(--actor-agent)] bg-[var(--actor-agent)]/10"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="font-medium">{c.label}</div>
                      <div className="text-xs text-muted-foreground">{c.hint}</div>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Autopilot reads every application together when the window
                closes, so nobody wins by refreshing fastest. Anyone who applies
                later is still scored on the next pass.
                {preview && chosenWindow !== null &&
                  chosenWindow !== preview.defaultWindowMinutes && (
                    <>
                      {" "}Changing this from the default asks for one signature —
                      free, and no transaction.
                    </>
                  )}
              </p>
            </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDelegate()}>
              Hand it over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
