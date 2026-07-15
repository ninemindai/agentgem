// Test setup for the marketplace SPA.
//
// Node 26 defines `localStorage`/`sessionStorage` as own globals whose getters
// return undefined unless --localstorage-file is passed. Vitest's jsdom
// environment copies window keys onto the Node global but skips keys that
// already exist there (and neither storage is in its always-copy allowlist),
// so under Node 26 tests see the Node stub — `localStorage === undefined` —
// instead of jsdom's Storage. Bridge the real jsdom implementations back in
// from the JSDOM instance vitest exposes as `globalThis.jsdom`.
const dom = (globalThis as { jsdom?: { window: Record<string, unknown> } }).jsdom;
for (const key of ["localStorage", "sessionStorage"] as const) {
  if (dom && (globalThis as Record<string, unknown>)[key] === undefined && dom.window[key]) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  }
}

export {};
