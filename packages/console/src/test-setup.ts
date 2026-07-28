import { afterEach } from "vitest";
import { resetGem } from "./activeGem.js";

// Reset the active-Gem store between tests so module-level singleton state
// does not leak across test cases (equivalent to useState resetting per mount).
afterEach(() => resetGem());

// Recharts' ResponsiveContainer uses ResizeObserver, which jsdom doesn't provide.
// Stub it so Observe panel tests don't crash during render.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement Element.scrollIntoView. Stub it so panels that
// auto-scroll (e.g. Chat's message list) don't crash during render.
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom doesn't implement EventSource either, and six panels open one (Chat, Recall,
// Watch ×3, Play). The crash lands AFTER the awaiting test has already passed — the
// stream is opened in the continuation of a POST — so it surfaces as an unhandled
// rejection that fails the whole run while every assertion is green. A no-op stub keeps
// the run honest; a test that wants to assert on stream behaviour should inject its own.
if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = class EventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly readyState = 0;
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return false; }
    close() {}
  } as unknown as typeof globalThis.EventSource;
}
