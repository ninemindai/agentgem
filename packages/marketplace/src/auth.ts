/** Web sign-in client. All calls are credentialed so the parent-domain session cookie travels. */
export interface MyOrg { scope: string; role: string }
export interface Me { id: string; name: string; handle: string | null; avatarUrl: string | null; orgs: MyOrg[] }

export function makeAuth(base: string) {
  return {
    async getMe(): Promise<Me | null> {
      try {
        const r = await fetch(base + "/api/auth/get-session", { credentials: "include" });
        if (!r.ok) return null;
        // Identity is the uuid + an OPTIONAL handle, never `login`: a Google user has no login and
        // no handle until they claim one, but they ARE signed in. Gate on `user.id`, not `login`.
        // `handle` falls back to `login` so an existing GitHub user's /@ profile link keeps working
        // even if their handle column is somehow unset; `name` falls back to login then "".
        const j = (await r.json()) as {
          user?: { id?: string; name?: string; login?: string; handle?: string | null; image?: string | null };
          orgs?: MyOrg[];
        } | null;
        const u = j?.user;
        if (!u?.id) return null;
        return {
          id: u.id,
          name: u.name ?? u.login ?? "",
          handle: u.handle ?? u.login ?? null,
          avatarUrl: u.image ?? null,
          orgs: j?.orgs ?? [],
        };
      } catch { return null; }
    },
    async logout(): Promise<void> {
      try { await fetch(base + "/api/auth/sign-out", { method: "POST", credentials: "include" }); } catch { /* ignore */ }
    },
    /** better-auth 1.6.23's `/sign-in/social` is POST-only (no GET redirect form) — it returns
     *  `{ url, redirect }` rather than 302ing itself, so the caller must follow `url` by hand.
     *  Callers that used to read `loginUrl()` as a synchronous href must call this from a click
     *  handler instead. A non-2xx response, a 2xx with no (or empty) `url`, or a network failure
     *  all throw — this is the primary login path, so a caller MUST be able to catch/render the
     *  failure rather than have the click silently do nothing (see App.tsx's `signIn`). */
    async signIn(provider: "github" | "google", returnTo: string): Promise<void> {
      const r = await fetch(base + "/api/auth/sign-in/social", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, callbackURL: returnTo }),
      });
      if (!r.ok) throw new Error(`sign-in failed (${r.status})`);
      const j = (await r.json()) as { url?: string };
      if (!j.url) throw new Error("sign-in response had no redirect url");
      window.location.assign(j.url);
    },
  };
}
