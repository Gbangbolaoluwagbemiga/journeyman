import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// `globals: false` in vitest.config.ts means RTL's automatic cleanup (which
// relies on a global `afterEach`) never registers — without this, DOM from
// one test's render() leaks into the next and getByRole/getByText start
// matching duplicates across tests.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement these — Radix primitives (Dialog, Tabs, ScrollArea)
// touch them during mount/animation and throw without a stub.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

if (!("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error — test-only stub
  window.ResizeObserver = ResizeObserverStub;
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
