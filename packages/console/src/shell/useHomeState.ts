import { useCallback, useEffect, useState } from "react";
import { homeStateRoute, setHomeStateRoute, makeClient, type HomeState } from "../api/routes.js";

// Locked is the safe first-paint default: the rail renders collapsed-and-gated
// immediately, then re-renders once the real state lands — same "fetch after mount,
// degrade quietly on failure" shape as IdentityProvider.refresh.
const LOCKED: HomeState = { unlocked: false, existingUser: false, revealSeen: false };

/** Home unlock/reveal-seen state for the rail's progressive disclosure. React state
 *  only (no module-scoped store) — each Shell mount fetches its own copy. Setters
 *  POST one-way and apply the full record the server echoes back; the server itself
 *  never reverts unlocked→false, so there's no local "lock" path to support. */
export function useHomeState(apiBase: string) {
  const [state, setState] = useState<HomeState>(LOCKED);

  useEffect(() => {
    homeStateRoute.call(makeClient(apiBase))
      .then(setState)
      .catch(() => { /* best-effort — stays locked */ });
  }, [apiBase]);

  const setUnlocked = useCallback((unlocked: true) => {
    setHomeStateRoute.call(makeClient(apiBase), { body: { unlocked } })
      .then(setState)
      .catch(() => { /* best-effort — rail retries on next mount */ });
  }, [apiBase]);

  const setRevealSeen = useCallback((revealSeen: true) => {
    setHomeStateRoute.call(makeClient(apiBase), { body: { revealSeen } })
      .then(setState)
      .catch(() => { /* best-effort */ });
  }, [apiBase]);

  return { ...state, setUnlocked, setRevealSeen };
}
