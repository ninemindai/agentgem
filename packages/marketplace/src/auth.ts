/** Web sign-in client. All calls are credentialed so the parent-domain session cookie travels. */
export interface MyOrg { scope: string; role: string }
export interface Me { login: string; avatarUrl: string | null; orgs: MyOrg[] }

export function makeAuth(base: string) {
  return {
    async getMe(): Promise<Me | null> {
      try {
        const r = await fetch(base + "/api/auth/get-session", { credentials: "include" });
        if (!r.ok) return null;
        // better-auth's get-session returns `{ session, user } | null` — never the old flat
        // `{ login, avatarUrl, orgs, authenticated }` shape. `login`/`image` are the additionalField
        // + built-in mapped by mapProfileToUser (packages/aggregator/src/auth/betterAuth.ts). There is
        // no `orgs` on this endpoint — the old /api/auth/me sourced it from getAccountScopes, which
        // has no better-auth replacement wired yet, so it's empty until a follow-up adds one.
        const j = (await r.json()) as { user?: { login?: string; image?: string | null } } | null;
        const login = j?.user?.login;
        return login ? { login, avatarUrl: j?.user?.image ?? null, orgs: [] } : null;
      } catch { return null; }
    },
    async logout(): Promise<void> {
      try { await fetch(base + "/api/auth/sign-out", { method: "POST", credentials: "include" }); } catch { /* ignore */ }
    },
    /** better-auth 1.6.23's `/sign-in/social` is POST-only (no GET redirect form) — it returns
     *  `{ url, redirect }` rather than 302ing itself, so the caller must follow `url` by hand.
     *  Callers that used to read `loginUrl()` as a synchronous href must call this from a click
     *  handler instead. Best-effort: a network failure just leaves the user where they were. */
    async signIn(returnTo: string): Promise<void> {
      try {
        const r = await fetch(base + "/api/auth/sign-in/social", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "github", callbackURL: returnTo }),
        });
        const j = (await r.json()) as { url?: string };
        if (j.url) window.location.assign(j.url);
      } catch { /* ignore */ }
    },
  };
}
