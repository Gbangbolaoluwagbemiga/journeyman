/**
 * The board a managed worker sees: open jobs, their own work, and their money.
 *
 * Deliberately NOT the same component as Browse Jobs. That page is for someone
 * with a wallet who signs their own transactions; this one is for someone who
 * has never held a private key and applies with a button. Sharing a component
 * across those two would mean branching on wallet mode inside every action, and
 * the branch would eventually leak into the copy.
 *
 * What is shared is the rule: a worker never learns whether their client is a
 * person or an agent. Nothing here reads client mode, and the board must stay
 * that way — see lib/atelier/actor.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Hammer, Loader2, Paperclip, Search, Send, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/atelier/errors";
import { uploadMilestoneFileWithAuth, isApiConfigured } from "@/lib/api";
import {
  apply,
  me as fetchMe,
  minutesUntilClose,
  myWork,
  quests as fetchQuests,
  submit as submitWork,
  uploadAuth,
  deliveryTarget,
  type DeliveryTarget,
  withdraw,
  type Quest,
  type Worker,
  type WorkItem,
} from "@/lib/atelier/worker";

type BoardTab = "work" | "open";

export function WorkerBoard({
  worker,
  onWorkerChanged,
}: {
  worker: Worker;
  onWorkerChanged: (w: Worker) => void;
}) {
  const { toast } = useToast();
  /* Which half they are looking at. Defaults to work in progress, and moves
     itself to the open board when there is none — the useful answer on a first
     visit is "here is what you could take on", not an empty bench. */
  const [tab, setTab] = useState<BoardTab>("work");
  const pickedTab = useRef(false);

  const [quests, setQuests] = useState<Quest[]>([]);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  /* True only when we have nothing to show AND could not find out why. */
  const [unreachable, setUnreachable] = useState(false);
  const [applyingTo, setApplyingTo] = useState<string | null>(null);
  const [coverLetter, setCoverLetter] = useState("");
  const [busy, setBusy] = useState(false);

  /* Delivering finished work. The row used to say "You were hired — send your
     work" and offer no way to send it: the endpoint and the client call both
     existed, the board simply never wired them up, so a hired freelancer's only
     route to delivering was the Telegram bot. */
  const [deliveringTo, setDeliveringTo] = useState<string | null>(null);
  const [delivery, setDelivery] = useState("");

  /* What the stage is and what it will be marked against. Loaded when the box
     opens rather than for every row: it is a chain read per job, and most
     viewings of this board never open one. */
  const [target, setTarget] = useState<DeliveryTarget | null>(null);

  /* The actual work, when it is a file rather than a sentence. */
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openDelivery(escrowId: string) {
    setDeliveringTo(escrowId);
    setTarget(null);
    void deliveryTarget(escrowId)
      .then(setTarget)
      .catch(() => {
        /* Left null: the box still submits, and the daemon still resolves the
           stage. Better to deliver without the detail than not at all. */
      });
  }

  function closeDelivery() {
    setDeliveringTo(null);
    setDelivery("");
    setTarget(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const refresh = useCallback(async () => {
    /*
     * THREE READS, SETTLED SEPARATELY.
     *
     * This was a Promise.all with one catch around it, which made the page as
     * reliable as its least reliable read: a blink from the open-jobs list
     * discarded a perfectly good answer about the work on your bench, and the
     * board rendered as though you had none. Somebody watched their finished
     * job vanish because an unrelated request failed.
     *
     * Nothing here depends on anything else here, so nothing else should be
     * lost when one of them fails. Each result is applied on its own, and the
     * ones that failed leave what was already on screen alone.
     */
    const [q, w, m] = await Promise.allSettled([
      fetchQuests(worker.id),
      myWork(worker.id),
      fetchMe(worker.id),
    ]);

    if (q.status === "fulfilled") setQuests(q.value);
    if (w.status === "fulfilled") setWork(w.value);
    if (m.status === "fulfilled") onWorkerChanged(m.value);

    /*
     * Still no toast — this polls, and one every few seconds because the daemon
     * blinked would be worse than a stale board. But the LIST must not be
     * emptied on a failed read: the daemon refuses to answer at all rather than
     * claim an empty bench, and clearing `work` here would reintroduce exactly
     * the disappearance it was changed to prevent.
     *
     * A job vanishing without explanation is the worst thing this page can do —
     * somebody's work and their money look gone.
     */
    if (w.status === "fulfilled") setUnreachable(false);
    else setUnreachable((was) => was || work.length === 0);

    setLoading(false);
  }, [worker.id, onWorkerChanged, work.length]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const finished = work.filter((w) => w.state === "completed").length;
  const inProgress = work.filter((w) => w.state === "hired").length;
  const applied = work.filter((w) => w.state === "applied").length;
  /* Finished jobs where an arbiter, not the reviewer, closed a stage. */
  const arbitratedJobs = work.filter(
    (w) => w.state === "completed" && (w.arbitrated ?? 0) > 0,
  ).length;

  /* Once, after the first load. Any later move is the person's own, and a poll
     that yanked them back to the other tab mid-typing would be maddening. */
  useEffect(() => {
    if (loading || pickedTab.current) return;
    pickedTab.current = true;
    if (work.length === 0 && quests.length > 0) setTab("open");
  }, [loading, work.length, quests.length]);

  async function sendDelivery(escrowId: string) {
    setBusy(true);
    try {
      let description = delivery.trim();

      /*
       * Upload first, and let a failure here stop the submission.
       *
       * The file IS the deliverable — submitting the sentence without it would
       * put work in front of a reviewer with the evidence missing, and the
       * reviewer would rightly reject it for exactly that. Better to fail
       * before anything reaches the chain than to deliver half of it.
       *
       * The attachment is appended in the form the rest of Atelier already
       * reads, so the client's card renders it and the agent's vision reviewer
       * can open it.
       */
      if (file) {
        const index = target?.index ?? 0;
        const auth = await uploadAuth({ workerId: worker.id, escrowId, milestoneIndex: index });
        const uploaded = await uploadMilestoneFileWithAuth(file, escrowId, index, auth);
        description = `${description}\n\n[Attachment: ${uploaded.filename ?? file.name}](${uploaded.url})`.trim();
      }

      /* No milestoneIndex on purpose — the daemon resolves which stage actually
         needs delivering. Hard-coding 0 filed a second milestone's work
         against the first. */
      await submitWork({ workerId: worker.id, escrowId, description });
      toast({
        title: "Work submitted",
        description:
          "It is on-chain and waiting on review. You will hear as soon as the milestone is approved and paid.",
      });
      closeDelivery();
      await refresh();
    } catch (e) {
      toast(toastError("Could not submit your work", e));
    } finally {
      setBusy(false);
    }
  }

  async function sendApplication(escrowId: string) {
    setBusy(true);
    try {
      await apply({
        workerId: worker.id,
        escrowId,
        coverLetter: coverLetter.trim(),
      });
      toast({
        title: "Application sent",
        description: "Autopilot scores every applicant together when the window closes.",
      });
      setApplyingTo(null);
      setCoverLetter("");
      void refresh();
    } catch (e) {
      toast(toastError("Could not send that application", e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground py-12">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading the board…
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <Earnings worker={worker} onWithdrawn={() => void refresh()} />

      {/*
        WHAT THEY HAVE DONE, AND HOW IT WENT.

        The client's dashboard has always carried these; a managed worker saw a
        balance and a list of tasks. Same marketplace, and the side that arrives
        with no wallet and no history is the side that most needs somewhere to
        build one.

        Read from the work already loaded, not fetched again — the numbers
        cannot disagree with the list they are describing.
      */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* "paid in full" was a flat claim about every finished job. One of
            them had a stage taken off the freelancer by an arbiter, so the hint
            says what is actually true of the set. */}
        <Stat
          label="Finished"
          value={String(finished)}
          hint={arbitratedJobs > 0 ? `${arbitratedJobs} went to an arbiter` : "paid in full"}
        />
        <Stat label="In progress" value={String(inProgress)} hint="on your bench" />
        <Stat label="Applied" value={String(applied)} hint="awaiting a decision" />
        <Stat
          label="Rating"
          value={worker.rating && worker.rating.count > 0 ? worker.rating.average.toFixed(1) : "—"}
          hint={
            worker.rating && worker.rating.count > 0
              ? `${worker.rating.count} job${worker.rating.count === 1 ? "" : "s"} rated`
              : "after your first job"
          }
        />
      </div>

      {/*
        ONE AT A TIME, THE WAY MY JOBS DOES IT.

        These answer different questions — "what do I owe" and "what could I
        take on" — and a freelancer is doing one or the other, never both at
        once. Stacked they read as one long list and the committed work scrolls
        off the top as soon as a few jobs are open; side by side each gets half
        a screen it does not need.
      */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as BoardTab)}>
        <TabsList className="overflow-x-auto justify-start max-w-full">
          <TabsTrigger value="work" className="gap-2 shrink-0">
            <Hammer className="h-4 w-4" aria-hidden="true" />
            Your work
            {work.length > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">{work.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="open" className="gap-2 shrink-0">
            <Search className="h-4 w-4" aria-hidden="true" />
            Open jobs
            {quests.length > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">{quests.length}</span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Both stay mounted. Switching tabs must not throw away a half-typed
            delivery or re-fetch a board that was already loaded. */}
        <TabsContent value="work" forceMount hidden={tab !== "work"} className="mt-6">
        <section className="min-w-0">
          <h2 className="sr-only">Your work</h2>
          <div className="space-y-3">
            {work.map((w) => (
              <div key={w.escrowId} className="rounded-xl glass p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate">{w.title}</span>
                      {/* Who decides here — the same standing fact the client's
                          card shows, because it changes what waiting means. */}
                      {w.reviewer && (
                        <span
                          className={`actor-chip shrink-0 ${w.reviewer === "agent" ? "actor-agent" : "actor-human"}`}
                          title={
                            w.reviewer === "agent"
                              ? "An agent reviews and releases payment on this job"
                              : "The client reviews and releases payment themselves"
                          }
                        >
                          <span className="actor-dot" />
                          {w.reviewer === "agent" ? "Autopilot" : "Client-run"}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {w.icon} {w.status}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="actor-figure figure-md">${w.budget}</span>
                    {w.state === "hired" && w.canSubmit !== false && deliveringTo !== w.escrowId && (
                      <Button size="sm" onClick={() => openDelivery(w.escrowId)}>
                        <Send className="h-4 w-4 mr-2" aria-hidden="true" />
                        Send work
                      </Button>
                    )}
                  </div>
                </div>

                {/*
                  WHO IS HOLDING THIS, AND ROUGHLY FOR HOW LONG.

                  A freelancer waiting on a verdict cannot tell an agent that
                  answers in minutes from a client who answers when they next
                  open the tab — both look like silence. The wait is the same
                  either way; the worry is not.
                */}
                {(w.awaitingReview ?? 0) > 0 && deliveringTo !== w.escrowId && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {w.awaitingReview === 1
                      ? "One stage is with the reviewer."
                      : `${w.awaitingReview} stages are with the reviewer.`}{" "}
                    {w.reviewer === "agent"
                      ? "Autopilot is reviewing — that usually takes a few minutes."
                      : w.reviewer === "client"
                        ? "The client reviews this one themselves, so it can take longer than an agent would."
                        : "You will hear as soon as it is decided."}{" "}
                    The next stage opens once this one is decided.
                  </p>
                )}

                {/*
                  A JOB THAT WENT TO AN ARBITER, AND WHAT THEY DECIDED.

                  This row had no way to open, so a freelancer whose milestone
                  had been through a dispute could see that it was over and
                  never what had been decided. The split is on-chain; the
                  written reason is not — it is saved in the resolver's own
                  browser, so there is nowhere to read it from. Showing the
                  money is honest; implying there is a reasoning we can produce
                  would not be.
                */}
                {w.state === "completed" && (
                  <button
                    type="button"
                    onClick={() => (deliveringTo === w.escrowId ? closeDelivery() : openDelivery(w.escrowId))}
                    className="text-xs text-muted-foreground hover:text-foreground mt-2 underline underline-offset-2"
                  >
                    {deliveringTo === w.escrowId ? "Hide the details" : "See how this ended"}
                  </button>
                )}

                {w.state === "completed" && deliveringTo === w.escrowId && target && (
                  <div className="mt-3 rounded-lg border bg-muted/30 p-3 space-y-2 text-sm">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      {target.disputeOutcome ? "An arbiter decided this stage" : "How this stage ended"}
                    </div>

                    {/*
                      The job-level summary, when an arbiter was involved in ANY
                      stage. The panel below describes one stage; this line stops
                      the good stage speaking for the whole job. Escrow 7's first
                      stage was approved and its second was taken off the
                      freelancer, and the panel said "Approved and paid in full".
                    */}
                    {(w.arbitrated ?? 0) > 0 && typeof w.earnedUsdc === "number" && (
                      <p className="text-xs text-muted-foreground">
                        Across this job you were paid{" "}
                        <span className="text-foreground font-medium">
                          ${w.earnedUsdc.toFixed(2)}
                        </span>{" "}
                        — {w.approved ?? 0} of {w.milestoneCount ?? 0} stage(s)
                        approved, {w.arbitrated} settled by an arbiter.
                      </p>
                    )}

                    {target.disputeOutcome ? (
                      <>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">You received</span>
                          <span className="font-medium">${target.disputeOutcome.freelancerUsdc}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">Returned to the client</span>
                          <span className="font-medium">${target.disputeOutcome.clientUsdc}</span>
                        </div>
                        {target.disputeOutcome.reason ? (
                          <div className="pt-1">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                              Why they decided that
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {target.disputeOutcome.reason}
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            A human arbiter settled this, not the agent. They did
                            not record a written reason for this one — only the
                            split above, which is on-chain.
                          </p>
                        )}


                      </>
                    ) : (w.arbitrated ?? 0) > 0 ? (
                      /* Some other stage went to an arbiter. Saying "paid in
                         full" about this one, on a job where they were not, is
                         the claim that started this. */
                      <p className="text-muted-foreground">
                        This stage was approved and paid. Another stage on this
                        job went to an arbiter — the figures above are what you
                        actually received.
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        Approved and paid in full. Nothing further is needed from
                        you on this one.
                      </p>
                    )}
                  </div>
                )}

                {/* Sent back. The one state where doing nothing is the wrong move. */}
                {(w.needsRevision ?? 0) > 0 && (w.awaitingReview ?? 0) === 0 && deliveringTo !== w.escrowId && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Your last delivery was sent back with feedback. Open{" "}
                    <span className="text-foreground">Send work</span> to read it
                    and resend — the money is still locked in escrow for you.
                  </p>
                )}

                {w.state === "hired" && w.canSubmit !== false && deliveringTo === w.escrowId && (
                  <div className="mt-4 space-y-3">
                    {/*
                      WHICH STAGE, AND WHAT IT HAS TO MEET.

                      This box used to be a bare textarea. On a two-stage job it
                      silently chose a milestone for you, and on an agent-run job
                      a machine then approved or rejected what you wrote against
                      criteria you had never been shown.
                    */}
                    {target && (
                      <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                              {target.count > 1
                                ? `Milestone ${target.index + 1} of ${target.count}`
                                : "This job pays in one stage"}
                            </div>
                            {target.description && (
                              <p className="text-sm mt-1 wrap-break-word">
                                {target.description}
                              </p>
                            )}
                          </div>
                          {target.amountUsdc !== null && (
                            <span className="actor-figure figure-sm shrink-0">
                              ${target.amountUsdc}
                            </span>
                          )}
                        </div>

                        {/* What was wrong last time — written by the reviewer,
                            and never shown to the person asked to fix it. */}
                        {target.previousFeedback && (
                          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                            <div className="text-xs uppercase tracking-wide mb-1">
                              Why this came back
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {target.previousFeedback}
                            </p>
                          </div>
                        )}

                        {/*
                          THE VERDICT, CRITERION BY CRITERION.

                          The reviewer produced this and stored it every time.
                          The freelancer — the only person who can act on it —
                          saw a status change and nothing else. Shown in place
                          of the plain criteria list, because once there is a
                          verdict the verdict IS the list.
                        */}
                        {target.lastReview ? (
                          <div>
                            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center justify-between gap-2">
                              <span>
                                {target.agentReviewed ? "The agent checked" : "The client checked"}
                                {" "}each criterion
                              </span>
                              {target.lastReview.score !== null && (
                                <span className="font-mono">{target.lastReview.score}/100</span>
                              )}
                            </div>
                            <ul className="space-y-1.5">
                              {target.lastReview.criteriaResults.map((c, i) => (
                                <li key={i} className="flex gap-2 text-xs">
                                  <span
                                    className={c.passed ? "text-green-500" : "text-red-500"}
                                    aria-hidden="true"
                                  >
                                    {c.passed ? "✓" : "✗"}
                                  </span>
                                  <span className="min-w-0">
                                    <span className={c.passed ? "text-muted-foreground" : "text-foreground"}>
                                      {c.criterion}
                                    </span>
                                    {c.note && (
                                      <span className="block text-muted-foreground/80">
                                        {c.note}
                                      </span>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            <p className="text-xs text-muted-foreground mt-2">
                              Fix the ones marked ✗ and send it again. The budget
                              stays locked in escrow for you in the meantime.
                            </p>
                          </div>
                        ) : target.criteria.length > 0 && (
                          <div>
                            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                              {target.agentReviewed
                                ? "An agent approves or rejects against"
                                : "The client is looking for"}
                            </div>
                            <ul className="space-y-1">
                              {target.criteria.map((c, i) => (
                                <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                                  <span className="actor-dot mt-1" aria-hidden="true" />
                                  <span className="min-w-0">{c}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {target.count > 1 && (
                          <p className="text-xs text-muted-foreground">
                            Only this stage is being delivered. The rest stay
                            funded and are sent separately.
                          </p>
                        )}
                      </div>
                    )}

                    <Label htmlFor={`wk-${w.escrowId}`} className="text-xs">
                      What did you deliver?
                    </Label>
                    <Textarea
                      id={`wk-${w.escrowId}`}
                      rows={3}
                      value={delivery}
                      onChange={(e) => setDelivery(e.target.value)}
                      placeholder="Describe what you produced and where it is — a link, a file, a repo. This is what gets reviewed against the job's criteria."
                      className="text-sm resize-none"
                    />
                    {/*
                      THE WORK ITSELF, not a description of it.

                      A designer delivering a logo had no way to send the logo:
                      this box took a sentence, and the only route for a file was
                      the Telegram bot. Meanwhile the agent reviewing it has a
                      vision model and was being handed prose about an image it
                      could have opened — and then failing the submission for
                      having no deliverable, which is exactly what happened here.
                    */}
                    {isApiConfigured() && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          ref={fileInputRef}
                          type="file"
                          className="sr-only"
                          id={`file-${w.escrowId}`}
                          accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,application/zip,.doc,.docx"
                          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip className="h-4 w-4 mr-2" aria-hidden="true" />
                          {file ? "Change file" : "Attach a file"}
                        </Button>

                        {file ? (
                          <span className="inline-flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1 min-w-0">
                            <span className="truncate max-w-[12rem]">{file.name}</span>
                            <span className="text-muted-foreground shrink-0">
                              {(file.size / 1024 / 1024).toFixed(1)} MB
                            </span>
                            <button
                              type="button"
                              aria-label="Remove file"
                              disabled={busy}
                              onClick={() => {
                                setFile(null);
                                if (fileInputRef.current) fileInputRef.current.value = "";
                              }}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Images, PDF, zip or a doc — up to 10 MB. The reviewer
                            opens it.
                          </span>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2 justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={closeDelivery}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void sendDelivery(w.escrowId)}
                        disabled={busy || (delivery.trim().length === 0 && !file)}
                      >
                        {busy && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                        )}
                        Submit for review
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Said plainly rather than shown as an empty panel — a freelancer
              with nothing on should be pointed at the tab that has something
              on it. */}
          {work.length === 0 && (
            <div className="rounded-xl glass p-8 text-center text-sm text-muted-foreground">
              {unreachable ? (
                <>
                  We could not reach the job index just now, so this list is
                  incomplete rather than empty. Nothing has happened to your
                  work or your money — it is on-chain either way. Trying again.
                </>
              ) : (
                <>
                  Nothing on your bench right now. Anything you are hired for
                  shows up here, with what it needs and what it pays.
                </>
              )}
            </div>
          )}
        </section>
        </TabsContent>

        <TabsContent value="open" forceMount hidden={tab !== "open"} className="mt-6">
      <section className="min-w-0">
        <h2 className="sr-only">Open jobs</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Apply with a sentence. No gas, no signature.
        </p>

        {quests.length === 0 ? (
          <div className="rounded-xl glass p-8 text-center mt-4">
            <p className="text-sm text-muted-foreground">
              Nothing open right now. New jobs appear here as clients post them.
            </p>
          </div>
        ) : (
          <div className="space-y-4 mt-4">
            {quests.map((q) => {
              const mins = minutesUntilClose(q);
              return (
                <div key={q.escrowId} className="rounded-xl glass p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium">{q.title}</h3>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1.5">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {mins > 0
                            ? `closes in ${mins} min`
                            : "judging now"}
                        </span>
                        <span>{q.durationDays} days</span>
                        <span>{q.milestones.length} milestones</span>
                      </div>
                    </div>
                    <span className="actor-figure figure-md shrink-0">
                      ${q.budget}
                    </span>
                  </div>

                  {q.criteria.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {q.criteria.slice(0, 3).map((c, i) => (
                        <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                          <span className="actor-dot mt-1" aria-hidden="true" />
                          <span className="min-w-0">{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {q.applied ? (
                    <p className="text-xs text-muted-foreground mt-4">
                      You have applied. You will hear when the window closes.
                    </p>
                  ) : applyingTo === q.escrowId ? (
                    <div className="mt-4 space-y-2">
                      <Label htmlFor={`cl-${q.escrowId}`} className="text-xs">
                        Why you?
                      </Label>
                      <Textarea
                        id={`cl-${q.escrowId}`}
                        rows={3}
                        value={coverLetter}
                        onChange={(e) => setCoverLetter(e.target.value)}
                        placeholder="Answer the criteria above specifically — Autopilot scores generic applications lower."
                        className="text-sm resize-none"
                      />
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setApplyingTo(null);
                            setCoverLetter("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || coverLetter.trim().length < 10}
                          onClick={() => void sendApplication(q.escrowId)}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          Apply
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-4"
                      onClick={() => setApplyingTo(q.escrowId)}
                    >
                      Apply
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Earnings, and the button that gets the money out.
 *
 * Withdrawal is given more prominence than the balance itself, on purpose. A
 * managed wallet is a way to start without a wallet, not a place to keep
 * savings, and the interface should keep saying so rather than making custody
 * comfortable.
 */
function Earnings({
  worker,
  onWithdrawn,
}: {
  worker: Worker;
  onWithdrawn: () => void;
}) {
  const { toast } = useToast();
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  /* null means the daemon could not read it, which is not the same as zero.
     Showing 0.00 for an unreadable balance is a wrong number presented as a
     right one, and this is the screen where that matters most. */
  const balanceKnown = worker.balance !== null && worker.balance !== undefined;
  const balance = balanceKnown ? Number(worker.balance) : 0;
  const validDest = /^0x[a-fA-F0-9]{40}$/.test(destination.trim());
  const validAmount = Number(amount) > 0 && Number(amount) <= balance;

  async function send() {
    setBusy(true);
    try {
      await withdraw({
        workerId: worker.id,
        destination: destination.trim(),
        amountUsdc: amount,
      });
      toast({
        title: "Sent",
        description: `${amount} USDC is on its way to your own wallet.`,
      });
      setOpen(false);
      setAmount("");
      setDestination("");
      onWithdrawn();
    } catch (e) {
      toast(toastError("Could not withdraw", e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="actor-human rounded-2xl actor-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Earned
          </div>
          <div className="actor-figure figure-lg mt-1">
            {balanceKnown ? `$${balance.toFixed(2)}` : "—"}
            <span className="text-sm font-sans font-medium text-muted-foreground ml-2">
              USDC
            </span>
          </div>
          {!balanceKnown && (
            <p className="text-xs text-muted-foreground mt-1">
              Could not read your balance just now. It is not zero — try again in
              a moment.
            </p>
          )}
          <div className="text-xs text-muted-foreground mt-2 font-mono">
            {worker.address.slice(0, 10)}…{worker.address.slice(-6)}
            {worker.mode === "managed" && " · held for you"}
          </div>
        </div>

        {worker.mode === "managed" && (
          <Button
            variant="outline"
            onClick={() => setOpen((v) => !v)}
            disabled={balance <= 0}
          >
            <Wallet className="h-4 w-4 mr-2" aria-hidden="true" />
            Withdraw
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-5 pt-5 border-t border-border/40 space-y-3">
          <p className="text-sm text-muted-foreground">
            Send to a wallet you control. We hold the keys to this one, so it is
            not somewhere to leave money.
          </p>
          <div className="grid sm:grid-cols-[1fr_8rem] gap-3">
            <div>
              <Label htmlFor="dest" className="text-xs">
                Your address
              </Label>
              <Input
                id="dest"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="0x…"
                className="mt-1.5 font-mono text-sm"
              />
            </div>
            <div>
              <Label htmlFor="amt" className="text-xs">
                USDC
              </Label>
              <Input
                id="amt"
                type="number"
                step="0.01"
                max={balance}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1.5 tabular-nums"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !validDest || !validAmount}
              onClick={() => void send()}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Send
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * One standing number. Deliberately plain — these are facts about somebody's
 * working life, and dressing them up would make a first-timer's row of zeroes
 * feel like a verdict rather than a starting point.
 */
function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl glass p-3.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-display text-2xl font-semibold mt-0.5">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
    </div>
  );
}
