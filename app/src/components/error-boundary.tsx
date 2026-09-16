import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * WHAT A CRASH SHOULD LOOK LIKE.
 *
 * Without this, React unmounts the entire tree when any component throws, and
 * the page goes black — no navbar, no message, nothing to search for. That has
 * cost this project real time twice: Browse Jobs was an empty page for a day
 * because a hook was called inside a `.map()`, and My Jobs went blank with no
 * indication of where or why.
 *
 * The blackness is the bug, separately from whatever threw. Someone looking at
 * a black rectangle cannot tell a crash from a failed deploy, a stale dev
 * server, a bad route, or an ad blocker — and neither can whoever they report
 * it to.
 *
 * So: the error's own message, on screen, where the page would have been.
 *
 * WHY IT WRAPS THE ROUTE AND NOT THE APP
 *
 * The navbar survives, so the user can go somewhere else instead of reloading
 * into the same crash. A boundary at the root would take the navigation down
 * with the page and leave them stuck.
 *
 * WHY IT SHOWS THE STACK IN DEVELOPMENT ONLY
 *
 * A stack trace is what a developer needs and what a user cannot act on. In
 * production they get a sentence and a button; the detail goes to the console
 * either way, which is where anyone debugging a deployed build will look.
 */

interface Props {
  children: ReactNode;
  /** Resets the boundary when it changes — the route path, normally. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Always, in every build: this is the one place the component stack exists.
    console.error("[Atelier] render crash:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    /* Navigating away from a broken page should not carry the error with you.
       Without this, one crash makes every subsequent route look broken too. */
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const dev = import.meta.env.DEV;

    return (
      <div className="container mx-auto px-4 py-20 max-w-2xl" data-testid="error-boundary">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          <h1 className="font-display text-2xl font-bold">This page didn't load</h1>
        </div>

        <p className="text-muted-foreground mt-3 leading-relaxed">
          Something in the page threw an error, so it stopped rendering. Nothing
          on-chain is affected — your jobs, your escrow and your money are
          untouched by this.
        </p>

        <pre
          className="mt-4 overflow-x-auto rounded-lg border bg-muted/30 p-3 text-xs"
          data-testid="error-message"
        >
          {error.message || String(error)}
        </pre>

        {dev && error.stack && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Stack trace
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/30 p-3 text-[11px] leading-relaxed">
              {error.stack}
            </pre>
          </details>
        )}

        <div className="flex gap-3 mt-6">
          <Button onClick={() => window.location.reload()} className="gap-2">
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Reload the page
          </Button>
          <Button variant="outline" onClick={() => this.setState({ error: null })}>
            Try again without reloading
          </Button>
        </div>
      </div>
    );
  }
}
