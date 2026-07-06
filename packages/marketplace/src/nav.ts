// Client-side navigation primitives. The hand-rolled Router re-renders on popstate keyed by
// pathname; query params are page-level state, so pages that use them subscribe through
// useLocationSearch. navigate() is the ONE pushState + synthetic-popstate primitive — App's
// link interceptor and programmatic navigation (facet selects) share it, so the contract
// ("every in-app navigation dispatches popstate") lives in exactly one place.

import { useSyncExternalStore } from "react";

/** Navigate in-app: push the URL and wake every popstate subscriber (Router + page hooks). */
export function navigate(url: string): void {
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
};

/** The current location.search, reactive to both back/forward and in-app navigate() calls. */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search);
}
