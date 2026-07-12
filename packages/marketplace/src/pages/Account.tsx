import { useEffect, useMemo, useState } from "react";
import type { makeApi } from "../api";
import { makeAuth, type Me } from "../auth";
import { makePasskeyAuth, passkeySupported } from "../passkeyAuth";
import { PasskeysSection } from "./PasskeysSection";

// The known, connectable providers (Task 3's socialProviders). `connected` from the API is
// provider-agnostic (better-auth's own `account` table may carry ids this page doesn't know about,
// e.g. "credential" for email/password sign-up) — render only these, never an exhaustive union.
const KNOWN_PROVIDERS: { id: "github" | "google"; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
];

// Flow B needs to know WHICH provider a collision was for, to target the right one at the bespoke
// `/api/account/connect/:provider` start route. better-auth's OAuth round trip is a real full-page
// redirect (see the `linkSocial` doc comment in auth.ts) that remounts this page from scratch, so
// in-memory state can't carry it — and the returnTo/callbackURL wire format is pinned by the
// existing Flow-A tests (better-auth appends `?error=...`/`&error=...` to whatever we hand it, so a
// second query param would ride along fine, but changing the exact callbackURL string those tests
// assert on is out of scope here). sessionStorage survives the redirect without touching that wire
// format. Read-and-clear on every mount so a stale value never leaks into an unrelated later visit.
const CONNECT_ATTEMPT_KEY = "agentgem-connect-attempt";

type View = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; connected: string[] };
type ConnectStatus = "ready" | "none" | "error" | null;

/** /account: list connected providers, offer Connect for an unused one via better-auth's native
 *  `linkSocial` (Flow A). On a collision (a Connect resolves to a provider already linked to a
 *  DIFFERENT account), offers Flow B's absorb: a "Merge this account" button that starts the
 *  bespoke connect flow for that same provider; that flow's callback lands back here with
 *  `?connect=ready`, where confirming calls `absorbAccount` to fold the fresh account in. Also
 *  surfaces the handle-claim nudge (`?merge=1&handle=`, HandleClaim.tsx) when a claim 409'd because
 *  the name is already taken (owned by another account, or reserved — the server deliberately
 *  doesn't say which, see HandleClaim.tsx). */
export function Account({ api, me, base }: { api: ReturnType<typeof makeApi>; me: Me | null; base: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [linkError, setLinkError] = useState<string | null>(null);
  // better-auth's OAuth callback redirects a colliding link-social attempt back here with this exact
  // query param (see auth.ts's linkSocial doc comment) rather than rejecting the initial POST. Read
  // once at mount (a fresh redirect always remounts this page via Router) so the banner survives the
  // replaceState below instead of vanishing on the next unrelated re-render.
  const [collision] = useState(
    () => new URLSearchParams(window.location.search).get("error") === "account_already_linked_to_different_user",
  );
  // Which provider that collision was for — see CONNECT_ATTEMPT_KEY. null when unknown (e.g. private
  // browsing blocked sessionStorage, or someone bookmarked/reloaded a stale `?error=` URL): the Merge
  // button is withheld rather than guessing a provider, since guessing wrong would start the wrong
  // OAuth round trip.
  const [attemptedProvider] = useState<"github" | "google" | null>(() => {
    try {
      const p = sessionStorage.getItem(CONNECT_ATTEMPT_KEY);
      sessionStorage.removeItem(CONNECT_ATTEMPT_KEY);
      return p === "github" || p === "google" ? p : null;
    } catch { return null; }
  });
  // Task 2/6's bespoke connect callback shim redirects here with one of these (see
  // src/account/connect.ts) — read once, same rationale as `collision` above.
  const [connectStatus] = useState<ConnectStatus>(() => {
    const v = new URLSearchParams(window.location.search).get("connect");
    return v === "ready" || v === "none" || v === "error" ? v : null;
  });
  // HandleClaim.tsx's nudge after a claim 409 — see its doc comment for why this never names a
  // provider, only the handle the caller was trying to claim.
  const [mergeNudgeHandle] = useState<string | null>(() => {
    const qs = new URLSearchParams(window.location.search);
    return qs.get("merge") === "1" ? qs.get("handle") : null;
  });
  const [absorbBusy, setAbsorbBusy] = useState(false);
  const [absorbError, setAbsorbError] = useState<string | null>(null);
  const [absorbed, setAbsorbed] = useState(false);

  // Strip the one-shot query params from the address bar once they've been read: otherwise a
  // refresh re-shows a banner, and a later Connect (see `connect` below) could pick up a stale
  // `?error=` as part of its returnTo.
  // Deps intentionally omitted beyond the mount: collision/connectStatus/mergeNudgeHandle are each
  // captured once via a useState initializer above and never change afterward.
  useEffect(() => {
    if (!collision && !connectStatus && !mergeNudgeHandle) return;
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    api.getAccountProviders()
      .then((r) => { if (alive) setView({ status: "ok", connected: r.connected }); })
      .catch((e) => { if (alive) setView({ status: "error", message: String((e as Error)?.message ?? e) }); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [me]);

  const passkeyAuth = useMemo(() => makePasskeyAuth(base), [base]);

  if (!me) {
    const signIn = (provider: "github" | "google") => {
      setLinkError(null);
      makeAuth(base).signIn(provider, window.location.href).catch((err) => setLinkError(err instanceof Error ? err.message : String(err)));
    };
    return (
      <div className="ex-card">
        <p>Sign in to manage your connected accounts. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a></p>
        {linkError && <p className="ex-error">{linkError}</p>}
      </div>
    );
  }

  const connect = (provider: "github" | "google") => {
    setLinkError(null);
    // Stash which provider this attempt is for BEFORE the redirect — see CONNECT_ATTEMPT_KEY.
    try { sessionStorage.setItem(CONNECT_ATTEMPT_KEY, provider); } catch { /* private mode etc. — Merge just won't be offered */ }
    // origin + pathname only, no query string: this page's own URL can still carry a just-stripped
    // (or not-yet-stripped) `?error=...` from a prior collision, and that must never ride along as
    // this Connect's success callbackURL — see auth.ts's linkSocial doc comment.
    const returnTo = window.location.origin + window.location.pathname;
    makeAuth(base).linkSocial(provider, returnTo)
      .catch((err) => setLinkError(err instanceof Error ? err.message : String(err)));
  };

  // Flow B: start the bespoke connect flow for the SAME provider the collision was for.
  const mergeAccount = (provider: "github" | "google") => {
    makeAuth(base).connect(provider);
  };

  const confirmAbsorb = async () => {
    setAbsorbBusy(true);
    setAbsorbError(null);
    try {
      const r = await api.absorbAccount();
      setView({ status: "ok", connected: r.connected });
      setAbsorbed(true);
      // The session may have changed — absorb re-mints it when the caller's own (fresh) account was
      // the one dropped (see account/install.ts's absorbHandler). `me` is owned by App.tsx and not
      // reachable from here, so a reload is the only way to pick up the survivor's identity.
      window.location.reload();
    } catch (err) {
      setAbsorbError(err instanceof Error ? err.message : String(err));
    } finally {
      setAbsorbBusy(false);
    }
  };

  return (
    <div className="ex-card">
      <h2>Account</h2>
      {mergeNudgeHandle && (
        <p className="ex-empty" role="status">That handle (@{mergeNudgeHandle}) isn&apos;t available. If you have another account that might own it, connect it below.</p>
      )}
      {collision && (
        <p className="ex-error" role="alert">
          That provider is already linked to another AgentGem account.
          {attemptedProvider && (
            <> <button type="button" className="ex-signin" onClick={() => mergeAccount(attemptedProvider)}>Merge this account</button></>
          )}
        </p>
      )}
      {connectStatus === "ready" && !absorbed && (
        <div>
          <p>This merges the just-verified account — it has no gems, handle, or data — into this one.</p>
          <button type="button" className="ex-signin" disabled={absorbBusy} onClick={confirmAbsorb}>
            {absorbBusy ? "Connecting…" : "Connect"}
          </button>
          {absorbError && <p className="ex-error" role="alert">{absorbError}</p>}
        </div>
      )}
      {connectStatus === "none" && <p className="ex-empty">That account had nothing new to connect.</p>}
      {connectStatus === "error" && <p className="ex-error" role="alert">Something went wrong connecting that account. Try again.</p>}
      {view.status === "loading" && <p className="ex-empty">Loading…</p>}
      {view.status === "error" && <p className="ex-error">Couldn&apos;t load connected accounts: {view.message}</p>}
      {view.status === "ok" && (
        <ul className="ex-account-providers">
          {KNOWN_PROVIDERS.map(({ id, label }) => (
            <li key={id} className="ex-account-provider">
              <span>{label}</span>
              {view.connected.includes(id)
                ? <span className="ex-account-connected">{label} connected</span>
                : <button type="button" className="ex-signin" onClick={() => connect(id)}>Connect {label}</button>}
            </li>
          ))}
        </ul>
      )}
      {linkError && <p className="ex-error" role="alert">{linkError}</p>}
      {me && <PasskeysSection client={passkeyAuth} supported={passkeySupported()} />}
    </div>
  );
}
