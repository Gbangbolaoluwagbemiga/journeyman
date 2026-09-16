import { Trophy, Loader2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useDecisions } from "@/hooks/use-decisions";
import { useJobManager } from "@/hooks/use-job-manager";
import { AssigneeChip } from "@/components/atelier/assignee-chip";

/**
 * WHAT THE AGENT SCORED, AND WHY.
 *
 * The daemon has always recorded a score and a reason for every applicant it
 * read. Both were dropped by the mapper between the API and the UI, so the
 * number behind every hire existed on the wire and nowhere a person could see
 * it. Telegram told a rejected applicant their score; the web app told them
 * nothing at all, and a client could not see why one of five people was picked.
 *
 * WHY THE FREELANCER SEES ONLY THEIR OWN
 *
 * The client is choosing between people and needs the comparison. An applicant
 * needs to know how they did and what to fix — and giving them everyone else's
 * score and critique would publish strangers' rejections to each other, which
 * is not the applicant's to read and would make applying feel like a public
 * examination.
 *
 * WHY IT IS SHOWN TO A FREELANCER AT ALL
 *
 * There is a rule in this codebase that a freelancer should not be able to tell
 * whether their client is a person or an agent. It has already been overtaken:
 * the job board shows an AUTOPILOT MANAGED badge to everyone, and the bot
 * quotes the score and the bar to anybody it turns down. Keeping the web app
 * silent would not preserve the rule — it would only mean the one channel a
 * freelancer is most likely to use is the one that tells them least.
 */

interface Props {
  escrowId: number | string;
  /** The client sees every applicant; anyone else sees only themselves. */
  isClient: boolean;
  /** The viewer's address, used to find their own row. */
  viewer?: string;
}

/** 55 is the configured bar; the daemon states it in the reasoning it writes. */
function band(score: number): { label: string; className: string } {
  if (score >= 80) return { label: "Strong", className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" };
  if (score >= 55) return { label: "Hireable", className: "bg-sky-500/10 text-sky-500 border-sky-500/30" };
  if (score >= 40) return { label: "Weak", className: "bg-amber-500/10 text-amber-500 border-amber-500/30" };
  return { label: "Rejected", className: "bg-muted text-muted-foreground" };
}

export function ApplicantScores({ escrowId, isClient, viewer }: Props) {
  /*
   * Whether an agent runs this job is read from the chain, not passed in.
   * jobManager is the only trustworthy answer — the daemon's own task table can
   * be stale by exactly the interval between a client revoking and the next
   * poll — and asking here means no call site has to remember to.
   */
  const { manager, loaded } = useJobManager(Number(escrowId));
  const onAutopilot = !!manager;

  const { decisions, loading, error } = useDecisions(escrowId, { enabled: onAutopilot });

  if (!loaded || !onAutopilot) return null;

  const scored = decisions
    .filter((d) => typeof d.score === "number" && d.subject)
    .filter((d) => isClient || d.subject?.toLowerCase() === viewer?.toLowerCase());

  /* An unreachable daemon is not "nobody applied". Saying so would tell a
     freelancer they were ignored when the truth is we could not look. */
  if (error) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="scores-unavailable">
        Autopilot's scoring is unreachable right now — this says nothing about
        the applications themselves, which are on-chain either way.
      </p>
    );
  }

  if (loading && scored.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="scores-loading">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Reading the agent's notes…
      </p>
    );
  }

  /* Nothing scored yet is the ordinary state during the application window,
     and it is a different sentence for each side. */
  if (scored.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="scores-pending">
        {isClient
          ? "The agent hasn't read the applications yet. It waits for the window to close so it can compare everyone at once."
          : "Your application is in. The agent reads every applicant together once the window closes, so nothing is decided on who applied first."}
      </p>
    );
  }

  const ranked = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return (
    <div className="space-y-2" data-testid="applicant-scores">
      <h4 className="text-sm font-medium">
        {isClient ? "How the agent scored each applicant" : "How the agent scored you"}
      </h4>

      {ranked.map((d, i) => {
        const b = band(d.score!);
        const injection = /PROMPT INJECTION DETECTED/i.test(d.rationale ?? "");
        return (
          <div
            key={d.id}
            className="rounded-lg border border-border/60 p-3"
            data-testid="score-row"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                {isClient && i === 0 && (
                  <Trophy className="h-3.5 w-3.5 text-amber-500" aria-label="Highest score" />
                )}
                {isClient ? (
                  <AssigneeChip address={d.subject} label="Applicant" />
                ) : (
                  <span className="text-sm font-medium">Your application</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {injection && (
                  <Badge variant="outline" className="gap-1 text-[11px] border-destructive/40 text-destructive">
                    <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                    Injection attempt
                  </Badge>
                )}
                <Badge variant="outline" className={`text-[11px] ${b.className}`} data-testid="score-badge">
                  {d.score}/100 · {b.label}
                </Badge>
              </div>
            </div>

            {/* The reasoning carries the four-part breakdown the daemon writes,
                which is what turns a rejection into instructions. */}
            {d.rationale && (
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed" data-testid="score-reasoning">
                {d.rationale}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
