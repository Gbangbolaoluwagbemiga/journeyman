import { Routes, Route, Outlet, Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/error-boundary";
import { Navbar } from "./components/navbar";
import { AskAtelierDock } from "./components/atelier/ask-atelier-dock";
import { Toaster } from "./components/ui/toaster";
import { NewMessageWatcher } from "./components/new-message-watcher";
import { EscrowPoller } from "./components/escrow-poller";
import HomePage from "./pages/HomePage";
import JobsPage from "./pages/JobsPage";
import CreatePage from "./pages/CreatePage";
import AdminPage from "./pages/AdminPage";
import DisputesPage from "./pages/DisputesPage";
import ApprovalsPage from "./pages/ApprovalsPage";
import FreelancersPage from "./pages/FreelancersPage";
import MessagesPage from "./pages/MessagesPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import PostJobPage from "./pages/PostJobPage";
import MyJobsPage from "./pages/MyJobsPage";
import WorkerPage from "./pages/WorkerPage";
import AutopilotComposePage from "./pages/AutopilotComposePage";
import DevPreviewPage from "./pages/DevPreviewPage";

const AppLayout = () => {
  const { pathname } = useLocation();
  return (
    <>
      <Navbar />
      <div className="pt-16">
        {/*
          Around the route, not the app: a page that throws should not take the
          navigation down with it, or the only way out is a reload into the same
          crash. Keyed on the path so moving to another page clears the error
          rather than making every subsequent route look broken.
        */}
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
      <NewMessageWatcher />
      <EscrowPoller />
      {/*
        Outside the route's error boundary on purpose. If a page throws, the
        assistant is one of the few things still able to tell somebody what is
        going on — putting it inside would take it down with the page.
      */}
      <AskAtelierDock />
      <Toaster />
    </>
  );
};

/**
 * Atelier's routes.
 *
 * The IA is in `lib/atelier/nav.ts`; this table implements it. Two things worth
 * knowing before editing:
 *
 * 1. The original app's paths still resolve. /create, /dashboard and
 *    /freelancer redirect rather than 404, because the deployed app, the README
 *    and real users' bookmarks all point at them. A tidier table is not worth a
 *    regression on a product already in use.
 *
 * 2. /create is still a live route, not only a redirect target — it is the
 *    manual escrow wizard, which "Post a Job → Manual" leads into. The redirect
 *    is on the *bare* /create path only; deep links with query params (the
 *    wizard uses ?edit=) keep working.
 */
function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />

        {/* ── One list. Agent-posted and human-posted, indistinguishable. ── */}
        <Route path="/jobs" element={<JobsPage />} />
        {/* Deep link from a notification (Telegram, email) straight to one job. */}
        <Route path="/jobs/:jobId" element={<JobsPage />} />
        <Route path="/freelancers" element={<FreelancersPage />} />

        {/* ── Client area — the only part of the app that has modes. ── */}
        <Route path="/post" element={<PostJobPage />} />
        <Route path="/post/autopilot" element={<AutopilotComposePage />} />
        <Route path="/create" element={<CreatePage />} />
        {/* Both sides of the table, one destination. Tabs appear only for
            someone who actually has both roles. */}
        <Route path="/my-jobs" element={<MyJobsPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />

        {/* The no-wallet door. Reachable WITHOUT connecting anything — that is
            the entire point of it, so it must never sit behind the wallet gate
            that protects the client area. */}
        <Route path="/get-hired" element={<WorkerPage />} />

        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/admin" element={<AdminPage />} />

        {/* Arbitration. Reached from Admin, not from the nav — it is a staff
            tool, and the people in a dispute reach it from the job itself. */}
        <Route path="/disputes" element={<DisputesPage />} />

        {/*
          Dev-only surface preview. Gated on the build flag rather than hidden,
          so the route does not exist in production and the component is dropped
          from the bundle — this page would otherwise show one client's decision
          log to anyone who guessed the URL.
        */}
        {import.meta.env.DEV && (
          <Route path="/dev" element={<DevPreviewPage />} />
        )}

        {/* ── The original app's paths, kept alive. ── */}
        <Route path="/dashboard" element={<Navigate to="/my-jobs" replace />} />
        <Route path="/work" element={<Navigate to="/my-jobs?tab=working" replace />} />
        {/* A notification links straight here, and so does anyone who bookmarked
            the thing they check most often. */}
        <Route path="/applications" element={<Navigate to="/my-jobs?tab=applications" replace />} />
        <Route path="/freelancer" element={<Navigate to="/my-jobs?tab=working" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
