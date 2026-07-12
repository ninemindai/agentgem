import { useSyncExternalStore } from "react";

// Reactive navigator.onLine. Mirrors nav.ts's useSyncExternalStore idiom. SSR-safe getServerSnapshot
// returns true (assume online) though this SPA never server-renders.
function subscribe(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
