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

// jsdom does not install Web Storage under Node 26: `window.localStorage` and the global are
// BOTH undefined there, while both are real objects on Node 24. Console code reads bare
// `localStorage` — correct in a browser, and what every call site here does — so 149 tests fail
// on the release-tag Node 26 matrix while all 1153 pass on 24. (Node 26 does define its own
// global accessor, but it is inert without --localstorage-file and only emits a warning.)
//
// Provide an in-memory Storage when the environment has none. setupFiles run per test file, so
// each file gets its own instance and cannot leak keys into the next.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
  } as Storage;
}

for (const key of ["localStorage", "sessionStorage"] as const) {
  let present: unknown;
  try { present = globalThis[key] ?? window[key]; } catch { present = undefined; }
  if (present) continue;
  const store = memoryStorage();
  for (const target of [globalThis, window] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(target, key, { value: store, configurable: true, writable: true });
  }
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

