/** Web sign-in client. All calls are credentialed so the parent-domain session cookie travels. */
export interface MyOrg { scope: string; role: string }
export interface Me { login: string; avatarUrl: string | null; orgs: MyOrg[] }

export function makeAuth(base: string) {
  return {
    async getMe(): Promise<Me | null> {
      try {
        const r = await fetch(base + "/api/auth/get-session", { credentials: "include" });
        if (!r.ok) return null;
        // better-auth's get-session returns `{ session, user, orgs } | null` — never the old flat
        // `{ login, avatarUrl, orgs, authenticated }` shape. `login`/`image` are the additionalField
        // + built-in mapped by mapProfileToUser (packages/aggregator/src/auth/betterAuth.ts). `orgs`
        // is enriched onto the same payload by the `customSession` plugin there, sourced from
        // getAccountScopes (self scope excluded) — see betterAuth.ts.
        const j = (await r.json()) as { user?: { login?: string; image?: string | null }; orgs?: MyOrg[] } | null;
        const login = j?.user?.login;
        return login ? { login, avatarUrl: j?.user?.image ?? null, orgs: j?.orgs ?? [] } : null;
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
    async signIn(returnTo: string): Promise<void> {
      const r = await fetch(base + "/api/auth/sign-in/social", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: returnTo }),
      });
      if (!r.ok) throw new Error(`sign-in failed (${r.status})`);
      const j = (await r.json()) as { url?: string };
      if (!j.url) throw new Error("sign-in response had no redirect url");
      window.location.assign(j.url);
    },
  };
}
