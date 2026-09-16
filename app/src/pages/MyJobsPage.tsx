/**
 * MY JOBS — one place, whichever side of the table you are on.
 *
 * Atelier previously had "My Work" and "My Jobs" as separate destinations, which
 * made sense to whoever built it and to nobody using it. Most people on a
 * marketplace like this do both: you hire someone for a logo and take a writing
 * job the same week. Two nav entries meant two dashboards, two mental models,
 * and two places to check whether anything needed you.
 *
 * So: one destination, and the tabs appear only if you actually have both roles.
 *
 *   both roles  → tabs, and it opens on whichever side needs you
 *   freelancer  → Working and Applications, but no Hiring
 *   client only → that side, no tabs, no reminder that another mode exists
 *   neither     → an explanation and the two ways to start
 *
 * A tab someone's role cannot use is never shown. A freelancer who has never
 * hired anybody does not need a permanently empty "Hiring" tab teaching them
 * the product has a part they are not using — and a client has nothing to see
 * under Applications, because they do not apply for anything.
 *
 * Applications is a tab and not a nav entry for the same reason Approvals is
 * not one: it is a state of your jobs, not a separate place. See nav.ts.
 */

import { useEffect, useMemo } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { Briefcase, Hammer, Loader2, Send } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/contexts/web3-context";
import { currentWorkerId } from "@/lib/atelier/worker";
import { useFreelancerStatus } from "@/hooks/use-freelancer-status";
import { useJobCreatorStatus } from "@/hooks/use-job-creator-status";
import {
  PageActionsProvider,
  PageActionsSlot,
} from "@/components/atelier/page-actions";
import DashboardPage from "@/pages/DashboardPage";
import FreelancerPage from "@/pages/FreelancerPage";
import { MyApplications } from "@/components/atelier/my-applications";

type Side = "hiring" | "working" | "applications";

const SIDES: readonly Side[] = ["hiring", "working", "applications"];

function isSide(v: string | null): v is Side {
  return SIDES.includes(v as Side);
}

export default function MyJobsPage() {
  const { wallet } = useWeb3();
  const { isFreelancer, loading: freelancerLoading } = useFreelancerStatus();
  const { isJobCreator, loading: clientLoading } = useJobCreatorStatus();
  const [params, setParams] = useSearchParams();

  const loading = freelancerLoading || clientLoading;
  const both = isJobCreator && isFreelancer;
  /* A freelancer gets tabs even without the hiring side, because Applications
     is a second thing to look at. A client-only account still gets none. */
  const tabbed = both || isFreelancer;

  /**
   * Which side to open on.
   *
   * A URL parameter wins, so /work can redirect here and land on the right tab
   * and a link to one side stays a link to that side. Otherwise default to
   * whichever role you have; with both, default to hiring, because that is the
   * side where something is usually waiting on YOU — a freelancer's jobs are
   * waiting on the freelancer's own work, which they know about already.
   */
  const requested = params.get("tab");
  const side: Side = useMemo(() => {
    /* A tab you cannot use is not a tab you get sent to, however the link was
       written — /my-jobs?tab=applications from a client's bookmark should land
       somewhere real rather than on an empty list. */
    if (isSide(requested)) {
      if (requested === "hiring" && !isJobCreator) return "working";
      if (requested !== "hiring" && !isFreelancer) return "hiring";
      return requested;
    }
    if (isJobCreator) return "hiring";
    if (isFreelancer) return "working";
    return "hiring";
  }, [requested, isJobCreator, isFreelancer]);

  /* Keep the URL honest once the roles resolve, so a refresh or a shared link
     lands in the same place rather than re-deciding. */
  useEffect(() => {
    if (loading || !tabbed) return;
    if (!isSide(requested)) {
      setParams({ tab: side }, { replace: true });
    }
  }, [loading, tabbed, requested, side, setParams]);

  /*
   * A MANAGED WORKER IS SIGNED IN, JUST NOT WITH A WALLET.
   *
   * This page assumes a connected wallet, which is right for the client side —
   * you cannot hire without signing. But a freelancer on a managed wallet holds
   * no key and never connects one, so every link that lands here dead-ended
   * them on "Connect a wallet to see your jobs". Including the notification
   * telling them a dispute over their own work had been decided: they tapped
   * it, and Atelier told them they were nobody.
   *
   * Their jobs live on their own board. Send them there rather than explaining
   * why this page cannot help.
   */
  if (!wallet.isConnected && currentWorkerId()) {
    return <Navigate to="/get-hired" replace />;
  }

  if (!wallet.isConnected) {
    return (
      <EmptyState
        title="Connect a wallet to see your jobs"
        body="Everything you have posted or been hired for lives here, on both sides."
      />
    );
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-24 flex items-center justify-center gap-2.5 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your jobs…
      </div>
    );
  }

  if (!isJobCreator && !isFreelancer) {
    return (
      <EmptyState
        title="Nothing here yet"
        body="Once you post a job or get hired for one, it shows up here — both sides in the same place."
      />
    );
  }

  /* Client only: give them that page, with nothing to switch between. */
  if (!tabbed) {
    return (
      <PageActionsProvider>
        <div className="min-h-screen py-8 sm:py-12">
          <div className="container mx-auto px-4 mb-6 sm:mb-8 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="font-display text-3xl sm:text-4xl font-bold">My Jobs</h1>
              <p className="text-muted-foreground mt-1.5">
                {isJobCreator
                  ? "The jobs you have posted and are paying for."
                  : "The jobs you have been hired for, and what you have earned."}
              </p>
            </div>
            <PageActionsSlot className="shrink-0" />
          </div>
          {isJobCreator ? <DashboardPage embedded /> : <FreelancerPage embedded />}
        </div>
      </PageActionsProvider>
    );
  }

  return (
    <PageActionsProvider>
    <div className="min-h-screen py-8 sm:py-12">
      <div className="container mx-auto px-4">
        <h1 className="font-display text-3xl sm:text-4xl font-bold">My Jobs</h1>
        <p className="text-muted-foreground mt-1.5">
          {both
            ? "You are hiring on some of these and working on others."
            : "The jobs you have been hired for, and the ones you are still waiting to hear about."}
        </p>

        <Tabs
          value={side}
          onValueChange={(v) => setParams({ tab: v }, { replace: true })}
          className="mt-6"
        >
          {/* Tabs on the left, the active page's own actions on the right, one
              row. The buttons are portalled in from whichever dashboard is
              mounted — see components/atelier/page-actions.tsx. */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* Scrolls rather than wrapping on a narrow screen — a tab bar that
                reflows onto two lines pushes the content down and looks broken. */}
            <TabsList className="overflow-x-auto justify-start max-w-full">
              {isJobCreator && (
                <TabsTrigger value="hiring" className="gap-2 shrink-0">
                  <Briefcase className="h-4 w-4" aria-hidden="true" />
                  Hiring
                </TabsTrigger>
              )}
              {isFreelancer && (
                <>
                  <TabsTrigger value="working" className="gap-2 shrink-0">
                    <Hammer className="h-4 w-4" aria-hidden="true" />
                    Working
                  </TabsTrigger>
                  <TabsTrigger value="applications" className="gap-2 shrink-0">
                    <Send className="h-4 w-4" aria-hidden="true" />
                    Applications
                  </TabsTrigger>
                </>
              )}
            </TabsList>
            <PageActionsSlot />
          </div>

          {/* Both stay mounted. Switching tabs should not re-fetch a dashboard
              that was already loaded — on a slow RPC that reads as the app
              losing your jobs every time you look at the other side. */}
          <TabsContent value="hiring" forceMount hidden={side !== "hiring"} className="mt-6">
            <DashboardPage embedded />
          </TabsContent>
          <TabsContent value="working" forceMount hidden={side !== "working"} className="mt-6">
            <FreelancerPage embedded />
          </TabsContent>
          {/* Not forceMount: unlike the dashboards, this is one cheap query and
              a freelancer wants it re-read when they come back to look, which
              is the whole reason they came back. */}
          <TabsContent value="applications" className="mt-6">
            <MyApplications />
          </TabsContent>
        </Tabs>
      </div>
    </div>
    </PageActionsProvider>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="container mx-auto px-4 py-20 sm:py-28 max-w-lg text-center">
      <h1 className="font-display text-2xl sm:text-3xl font-bold">{title}</h1>
      <p className="text-muted-foreground mt-3 leading-relaxed">{body}</p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center mt-8">
        <Button asChild>
          <Link to="/jobs">Browse jobs</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/post">Post a job</Link>
        </Button>
      </div>
    </div>
  );
}
