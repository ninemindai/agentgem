import { useCallback, useEffect, useRef, useState } from "react";
import { homeStateRoute, setHomeStateRoute, makeClient, type HomeState } from "../api/routes.js";

// Locked is the safe first-paint default: the rail renders collapsed-and-gated
// immediately, then re-renders once the real state lands — same "fetch after mount,
// degrade quietly on failure" shape as IdentityProvider.refresh.
const LOCKED: HomeState = { unlocked: false, existingUser: false, revealSeen: false };

// Render-hint cache (Task 8): seeds the very first paint's `unlocked` from what the
// LAST real server response said, so a returning-unlocked user doesn't see a flash of
// the locked rail on every load while the actual GET is in flight. The hint NEVER
// substitutes for server truth — every mount still fetches, and whatever the server
// says wins outright, including correcting a stale "unlocked" hint back to locked.
const HINT_KEY = "agentgem.console.homeState.hint";
function readHintUnlocked(): boolean {
  try { return localStorage.getItem(HINT_KEY) === "unlocked"; } catch { return false; }
}
function writeHint(unlocked: boolean): void {
  try { localStorage.setItem(HINT_KEY, unlocked ? "unlocked" : "locked"); } catch { /* storage unavailable */ }
}

// Matches the app's established lightweight-poll cadence (WarmingPill,
// NotificationsProvider, ActivityProvider, useBackgroundJobs all use 5s).
const POLL_MS = 5000;

/** Home unlock/reveal-seen state for the rail's progressive disclosure. React state
 *  only (no module-scoped store) — each Shell mount fetches its own copy. Setters
 *  POST one-way and apply the full record the server echoes back; the server itself
 *  never reverts unlocked→false, so there's no local "lock" path to support.
 *
 *  Polling is OPT-IN via `{ poll: true }` — Shell is the only caller that passes it.
 *  While still locked, Shell's instance then polls the same GET every 5s so it
 *  notices a DIFFERENT instance's unlock (e.g. Observe's or RevealContent's own
 *  `useHomeState`, flipped by the first-gem ceremony or "Show everything" while both
 *  are mounted at once) within one tick — otherwise Shell's rail would only learn
 *  about it on the next full reload, since it fetches once on mount and never again.
 *  Self-terminating: the poll stops for good the moment it observes `unlocked`,
 *  since the server never reverts it.
 *
 *  Observe's and RevealContent's instances must NOT poll: Observe uses `revealSeen`
 *  to pick which mode to render (first-run / ceremony / returning), and a poll
 *  landing mid-ceremony (RevealContent POSTs `revealSeen` right after the CTA's
 *  build resolves) would unmount the just-built GemCeremony out from under the user
 *  before they can click "Open in Curate". Only Shell needs live cross-instance
 *  notice; Observe/Reveal each still fetch once on mount and can POST through their
 *  own setters same as before. */
export function useHomeState(apiBase: string, options?: { poll?: boolean }) {
  const poll = options?.poll ?? false;
  const [state, setState] = useState<HomeState>(() => ({ ...LOCKED, unlocked: readHintUnlocked() }));
  // The rail treats "locked" as its own loading placeholder (see useHomeState's
  // module doc), but the reveal panel needs to tell "still fetching" apart from
  // "genuinely a first-run visitor" — a race would otherwise let the pre-consent
  // screen flash then get replaced by the ceremony/returning mode. `loading` flips
  // false once the one GET settles, success or failure, same as `state` itself.
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Shared apply for every source of server truth (initial fetch, poll, either
  // setter's response): updates state, refreshes the render-hint, and tears down the
  // poll the instant the server reports unlocked.
  const apply = useCallback((s: HomeState) => {
    setState(s);
    writeHint(s.unlocked);
    if (s.unlocked && pollRef.current !== undefined) {
      clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const fetchOnce = () =>
      homeStateRoute.call(makeClient(apiBase))
        .then((s) => { if (alive) apply(s); })
        .catch(() => { /* best-effort — stays at the prior value */ })
        .finally(() => { if (alive) setLoading(false); });

    fetchOnce();
    if (poll) pollRef.current = setInterval(fetchOnce, POLL_MS);
    return () => {
      alive = false;
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [apiBase, apply, poll]);

  const setUnlocked = useCallback((unlocked: true) => {
    setHomeStateRoute.call(makeClient(apiBase), { body: { unlocked } })
      .then(apply)
      .catch(() => { /* best-effort — rail retries on next mount/poll */ });
  }, [apiBase, apply]);

  const setRevealSeen = useCallback((revealSeen: true) => {
    setHomeStateRoute.call(makeClient(apiBase), { body: { revealSeen } })
      .then(apply)
      .catch(() => { /* best-effort */ });
  }, [apiBase, apply]);

  return { ...state, loading, setUnlocked, setRevealSeen };
}
