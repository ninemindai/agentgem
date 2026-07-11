import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { makeAuth, type Me } from "../auth";
import { useLocationSearch } from "../nav";

// The known, connectable providers (Task 3's socialProviders). `connected` from the API is
// provider-agnostic (better-auth's own `account` table may carry ids this page doesn't know about,
// e.g. "credential" for email/password sign-up) — render only these, never an exhaustive union.
const KNOWN_PROVIDERS: { id: "github" | "google"; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
];

type View = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; connected: string[] };

/** /account (Flow A only, Task 7): list connected providers, offer Connect for an unused one via
 *  better-auth's native `linkSocial`. The collision/absorb path and the handle-claim nudge are
 *  DEFERRED with Flow B — a Connect that resolves to a provider already linked to another account
 *  gets a plain message, no absorb offer. */
export function Account({ api, me, base }: { api: ReturnType<typeof makeApi>; me: Me | null; base: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [linkError, setLinkError] = useState<string | null>(null);
  // better-auth's OAuth callback redirects a colliding link-social attempt back here with this exact
  // query param (see auth.ts's linkSocial doc comment) rather than rejecting the initial POST.
  const collision = new URLSearchParams(useLocationSearch()).get("error") === "account_already_linked_to_different_user";

  useEffect(() => {
    if (!me) return;
    let alive = true;
    api.getAccountProviders()
      .then((r) => { if (alive) setView({ status: "ok", connected: r.connected }); })
      .catch((e) => { if (alive) setView({ status: "error", message: String((e as Error)?.message ?? e) }); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [me]);

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
    makeAuth(base).linkSocial(provider, window.location.href)
      .catch((err) => setLinkError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="ex-card">
      <h2>Account</h2>
      {collision && <p className="ex-error" role="alert">That provider is already linked to another AgentGem account.</p>}
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
    </div>
  );
}
