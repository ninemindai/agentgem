/// <reference lib="webworker" />
// The marketplace service worker. Built only by `vite build` (injectManifest); never runs in
// dev or vitest. Precaches the hashed app shell so the installed PWA opens offline, and serves
// game html pinned-first, then a recently-played cap-at-MAX_RECENT, evict-oldest-inserted cache.
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { isGameHtmlRequest, overLimit, PINNED_CACHE, RECENT_CACHE, MAX_RECENT } from "./swCache";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Workbox replaces self.__WB_MANIFEST at build time with the content-hashed asset list.
precacheAndRoute(self.__WB_MANIFEST);

// Offline document navigations (hard reload / deep-link at /gems/x, /offline, …) get the
// precached SPA shell so React boots and routes client-side; without this only "/" resolves
// offline. Navigations are document-mode requests to this origin only — never the cross-origin
// game-html fetch (mode "cors"), so this can't shadow the game cache above.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// Game html (cross-origin, from the API): pinned copy first (never evicted), else stale-while-
// revalidate into a small cap-at-MAX_RECENT, evict-oldest-inserted cache. Serving by request URL
// works because offline.pinGame stored the pin under the identical gameHtmlUrl(...). Immutable
// per (key,version), so revalidation is cheap.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "GET" && isGameHtmlRequest(url)) {
    event.respondWith(serveGame(event));
  }
});

async function serveGame(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const pinned = await caches.open(PINNED_CACHE);
  const pin = await pinned.match(request);
  if (pin) return pin;

  const recent = await caches.open(RECENT_CACHE);
  const cached = await recent.match(request);

  const fromNetwork = fetch(request)
    .then(async (res) => {
      if (res.ok) {
        await recent.put(request, res.clone());
        for (const k of overLimit(await recent.keys(), MAX_RECENT)) await recent.delete(k);
      }
      return res;
    })
    .catch(() => undefined);
  // Keep the worker alive until the background revalidation (put + cache trim) finishes, even
  // once respondWith settles from the cache — the SW may otherwise be terminated mid-flight.
  event.waitUntil(fromNetwork);

  // Stale-while-revalidate: hand back the cached copy immediately (network updates in the
  // background); with no cache, wait for the network; offline with neither, a network error.
  if (cached) return cached;
  return (await fromNetwork) ?? Response.error();
}

// registerType:"prompt" — the new SW waits until the user accepts the reload toast, then we
// skipWaiting on their signal (PwaUpdatePrompt posts this message).
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
