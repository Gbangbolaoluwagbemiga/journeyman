/**
 * A one-way bus from the worker layer to whoever announces things.
 *
 * WHY THIS EXISTS
 *
 * Every notification Atelier sends — SSE to the command center, the bell in the
 * web app, the Telegram message — hangs off AgentClient's event callback in
 * index.ts. That callback only fires for things the AGENT does.
 *
 * A freelancer delivering their work is not something the agent does. It goes
 * through the worker service, which emitted nothing at all, so a submission was
 * invisible everywhere: no bell, no Telegram, no live update. A client who had
 * bought something had to guess when it arrived and reload the page to find
 * out. The event type already existed and had a Telegram handler waiting for
 * it; nothing ever published one.
 *
 * index.ts subscribes; the worker layer publishes. Importing index.ts from the
 * worker layer would be a cycle, which is why this is its own file rather than
 * an export from there.
 */
import type { AgentEvent } from "./agent/AgentClient.js";

type Listener = (event: AgentEvent) => void;

const listeners = new Set<Listener>();

export function onWorkerEvent(fn: Listener): void {
  listeners.add(fn);
}

/**
 * Announce something a person did.
 *
 * Never throws. A notification that fails must not roll back work that is
 * already on-chain — the submission happened whether or not anyone was told.
 */
export function publishWorkerEvent(event: AgentEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn("[events] listener threw:", err instanceof Error ? err.message : err);
    }
  }
}
