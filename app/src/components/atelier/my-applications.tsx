import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, CheckCircle2, XCircle, Undo2, Loader2, Inbox } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/contexts/web3-context";
import { fetchMyApplications, type AppliedJob, type ApplicationOutcome } from "@/lib/atelier/applications";
import { categoryLabel, withoutMarker } from "@/lib/atelier/categories";
import { encodeJobId } from "@/lib/id-codec";

/**
 * THE LIST A FREELANCER HAD NOWHERE TO LOOK FOR.
 *
 * You could apply for a job and then never find out what happened. There was no
 * list of what you had applied to, no indication whether the client had chosen
 * anyone, and no way to tell "still deciding" from "gave it to someone else" —
 * a job simply went quiet, and quiet reads as rejection to everyone except the
 * person still hoping.
 *
 * A notification is a nudge and can be missed; this is the place you can go and
 * check. It is derived from the escrow itself, so it is right even when every
 * notification we sent was lost.
 *
 * WHY THE OUTCOMES ARE NAMED THE WAY THEY ARE
 *
 * "Still deciding" is separated from "went to someone else" because they ask
 * different things of the reader: one says wait, the other says apply
 * elsewhere. And a withdrawn job is its own row rather than a rejection —
 * losing a competition and the competition being called off are different
 * pieces of news, and merging them tells someone they were turned down when
 * nobody ever chose.
 */

const LOOK: Record<
  ApplicationOutcome,
  { label: string; icon: typeof Clock; className: string; testId: string }
> = {
  waiting: {
    label: "Still deciding",
    icon: Clock,
    className: "bg-yellow-100 text-yellow-800",
    testId: "outcome-waiting",
  },
  won: {
    label: "You got it",
    icon: CheckCircle2,
    className: "bg-green-100 text-green-800",
    testId: "outcome-won",
  },
  passed: {
    label: "Went to someone else",
    icon: XCircle,
    className: "bg-muted text-muted-foreground",
    testId: "outcome-passed",
  },
  withdrawn: {
    label: "Client withdrew the job",
    icon: Undo2,
    className: "bg-muted text-muted-foreground",
    testId: "outcome-withdrawn",
  },
};

function usdc(raw: string): string {
  const n = Number(raw || "0") / 1e6;
  return `$${n.toFixed(2)}`;
}

export function MyApplications() {
  const { wallet } = useWeb3();
  const [jobs, setJobs] = useState<AppliedJob[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!wallet.address) return;
    let live = true;
    setFailed(false);
    fetchMyApplications(wallet.address)
      .then((j) => { if (live) setJobs(j); })
      .catch(() => { if (live) { setJobs([]); setFailed(true); } });
    return () => { live = false; };
  }, [wallet.address]);

  if (!wallet.address) return null;

  if (jobs === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8" data-testid="applications-loading">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Looking up what you applied for…
      </div>
    );
  }

  /* An index we cannot reach is not "you have applied for nothing" — that
     sentence would be a lie told to someone who has applied for six things. */
  if (failed) {
    return (
      <Card className="p-6 text-center" data-testid="applications-unavailable">
        <p className="text-sm text-muted-foreground">
          We can't reach the index right now, so we can't show your applications.
          They are safe on-chain — this is only the list.
        </p>
      </Card>
    );
  }

  if (jobs.length === 0) {
    return (
      <Card className="p-8 text-center" data-testid="applications-empty">
        <Inbox className="h-8 w-8 mx-auto text-muted-foreground mb-3" aria-hidden="true" />
        <h3 className="font-medium">You haven't applied for anything yet</h3>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          When you apply, this is where you'll see whether the client has decided.
        </p>
        <Button asChild size="sm">
          <Link to="/jobs">Browse jobs</Link>
        </Button>
      </Card>
    );
  }

  const waiting = jobs.filter((j) => j.outcome === "waiting");
  const decided = jobs.filter((j) => j.outcome !== "waiting");

  return (
    <div className="space-y-6" data-testid="my-applications">
      <section>
        <h3 className="font-medium mb-3" data-testid="waiting-heading">
          Waiting on the client
          <span className="text-muted-foreground font-normal"> · {waiting.length}</span>
        </h3>
        {waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing outstanding — every job you applied for has been decided.
          </p>
        ) : (
          <div className="space-y-3">
            {waiting.map((j) => <Row key={j.escrowId} job={j} />)}
          </div>
        )}
      </section>

      {decided.length > 0 && (
        <section>
          <h3 className="font-medium mb-3" data-testid="decided-heading">
            Decided
            <span className="text-muted-foreground font-normal"> · {decided.length}</span>
          </h3>
          <div className="space-y-3">
            {decided.map((j) => <Row key={j.escrowId} job={j} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ job }: { job: AppliedJob }) {
  const look = LOOK[job.outcome];
  const Icon = look.icon;
  const category = categoryLabel(job.category as never);
  const title = job.projectTitle || withoutMarker(job.projectDescription) || encodeJobId(job.escrowId);

  return (
    <Card className="p-4" data-testid="application-row">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/jobs/${job.escrowId}`}
              className="font-medium truncate hover:underline"
            >
              {title}
            </Link>
            {category && (
              <Badge variant="outline" className="text-[11px] px-2 py-0">{category}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {usdc(job.totalAmount)} · applied{" "}
            {job.appliedAt > 0
              ? new Date(job.appliedAt * 1000).toLocaleDateString()
              : "recently"}
          </p>
        </div>

        <Badge className={`${look.className} gap-1 shrink-0`} data-testid={look.testId}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {look.label}
        </Badge>
      </div>
    </Card>
  );
}
