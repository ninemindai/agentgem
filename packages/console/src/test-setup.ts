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
