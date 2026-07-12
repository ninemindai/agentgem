/// <reference lib="webworker" />
// The marketplace service worker. Built only by `vite build` (injectManifest); never runs in
// dev or vitest. For now it precaches the hashed app shell so the installed PWA opens offline.
// Task 3 adds the game-html fetch handler (pinned-first, then a recently-played LRU).
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Workbox replaces self.__WB_MANIFEST at build time with the content-hashed asset list.
precacheAndRoute(self.__WB_MANIFEST);

// registerType:"prompt" — the new SW waits until the user accepts the reload toast, then we
// skipWaiting on their signal (PwaUpdatePrompt posts this message).
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
