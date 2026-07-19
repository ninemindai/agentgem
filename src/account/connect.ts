// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Bespoke Flow B connect flow. Start route redirects to the provider using better-auth's OWN
// registered callback (/api/auth/callback/:provider); the callback shim (registered BEFORE mountAuth)
// routes on `state`: our state -> we exchange + stashPendingLink; any other state -> next() to
// better-auth's own sign-in/link-social callback, untouched. The session is never read for identity
// and never swapped.
//
// ── STEP 1 PROVE-FIRST FINDINGS (better-auth@1.6.23 / @better-auth/core@1.6.23) ──────────────────
// 1. Provider object accessor. `ctx = await auth.$context`; `ctx.socialProviders` is an ARRAY whose
//    entries are either the provider value or a thunk resolving to it, each carrying `.id`
//    (better-auth/dist/api/routes/sign-in.mjs:71 does `getAwaitableValue(c.context.socialProviders,
//    { value })`; context/helpers.mjs:143 loops the array, awaiting function entries, matching `.id`).
//    `getConnectProvider` below replicates that tiny loop (no exported internal to import).
// 2. createAuthorizationURL shape (DIVERGES from the plan's `{url,state,codeVerifier}` return).
//    `provider.createAuthorizationURL({ state, codeVerifier, redirectURI, scopes, loginHint })`
//    (github.mjs:13 / google.mjs:45) is a PURE URL builder (no network) that RETURNS a `URL` object
//    only. It does NOT generate/return state or codeVerifier — the caller passes them in. In
//    better-auth's own sign-in these come from `generateState()` (state.mjs), which ALSO writes a
//    better-auth verification row its OWN callback later consumes. We must NOT use generateState:
//    our callback shim consumes OUR connect_states row, not better-auth's. So we mint our own opaque
//    random `state` and a PKCE `codeVerifier` (randomBytes→base64url; charset [A-Za-z0-9-_] is
//    PKCE-valid, matching core's own "a-z 0-9 A-Z -_" generator) and persist them via
//    stashConnectState(sha256(state), codeVerifier). Google THROWS without a codeVerifier
//    (google.mjs:50), GitHub ignores PKCE harmlessly — so we ALWAYS pass one, exactly as better-auth
//    does. Omitting `scopes` yields each provider's default scopes.
//    Exchange half (confirmed): validateAuthorizationCode({code,codeVerifier,redirectURI}) -> tokens;
//    getUserInfo({...tokens}) -> { user: { id } } (github id=profile.id, google id=user.sub);
//    redirectURI = `${ctx.baseURL}/callback/${provider}` (ctx.baseURL already includes /api/auth).
// 3. Shim-before-mountAuth. mountAuth registers `app.all("/api/auth/*splat", …)` (auth/mount.ts:21);
//    Express dispatches in registration order, so a `.get("/api/auth/callback/:provider")` registered
//    FIRST (installConnect before mountAuth) wins, and `next()` falls through to that `.all` catch-all
//    = better-auth. installHandoff already proves raw `/api/auth/*` routes coexist with the catch-all.
import { randomBytes, createHash } from "node:crypto";
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, stashConnectState, consumeConnectState, accountIdForProvider, stashPendingLink } from "@agentgem/aggregator";

type Auth = ReturnType<typeof makeAuth>;

/** OAuth-verified identity of the OTHER provider account. Injectable so route tests need no live
 *  OAuth — production leaves it undefined and the shim uses the real provider exchange. */
export type IdentityResolver = (
  provider: string,
  args: { code: string; codeVerifier: string; redirectURI: string },
) => Promise<{ providerId: string; providerAccountId: string } | null>;

export interface ConnectDeps {
  db: AppDb;
  auth: Auth;
  webOrigins: string[];
  publicBase: string;
  resolveIdentity?: IdentityResolver;
}

// duck-typed Express req/res (no @types/express dependency, matching auth/handoff.ts / account/install.ts)
interface Req { method: string; params: Record<string, string>; query: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; json(b: unknown): Res; redirect(code: number, url: string): Res }
type Next = () => void;
type ExpressApp = { get(p: string, h: (req: Req, res: Res, next: Next) => unknown): unknown };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const KNOWN = new Set(["github", "google", "twitter"]);

// minimal duck-type of a better-auth social provider (only what this flow calls)
interface Provider {
  id: string;
  createAuthorizationURL(a: { state: string; codeVerifier: string; redirectURI: string; scopes?: string[] }): Promise<URL> | URL;
  validateAuthorizationCode(a: { code: string; codeVerifier: string; redirectURI: string }): Promise<unknown>;
  getUserInfo(t: unknown): Promise<{ user?: { id?: unknown } } | null>;
}

/** Await-and-match over `ctx.socialProviders` (array of value|thunk, keyed by `.id`) — the same
 *  access better-auth's own sign-in uses via getAwaitableValue (see the header). */
async function getConnectProvider(auth: Auth, id: string): Promise<Provider | null> {
  const ctx = await auth.$context;
  const arr = (ctx as { socialProviders?: unknown }).socialProviders;
  if (!Array.isArray(arr)) return null;
  for (const val of arr) {
    const value = typeof val === "function" ? await val() : val;
    if (value?.id === id) return value as Provider;
  }
  return null;
}

/** Thin, testable wrapper over better-auth's provider exchange. Returns the OTHER account's
 *  server-verified identity, or null. `provider` is `ctx.socialProviders`' entry for the id. */
export async function resolveConnectIdentity(
  provider: Pick<Provider, "validateAuthorizationCode" | "getUserInfo">,
  args: { code: string; codeVerifier: string; redirectURI: string; providerId: string },
): Promise<{ providerId: string; providerAccountId: string } | null> {
  const tokens = await provider.validateAuthorizationCode({ code: args.code, codeVerifier: args.codeVerifier, redirectURI: args.redirectURI });
  if (!tokens) return null;
  const user = await provider.getUserInfo({ ...(tokens as object) }).then((r) => r?.user);
  const id = user?.id;
  if (id === undefined || id === null || id === "") return null;
  return { providerId: args.providerId, providerAccountId: String(id) };
}

export function connectStartHandler(deps: ConnectDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const provider = req.params.provider;
    if (!KNOWN.has(provider)) { res.status(404).json({ error: "unknown provider" }); return; }
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const p = await getConnectProvider(deps.auth, provider);
    if (!p) { res.status(404).json({ error: "provider not configured" }); return; }
    const ctx = await deps.auth.$context;
    const redirectURI = `${ctx.baseURL}/callback/${provider}`;
    // We mint state + codeVerifier ourselves (createAuthorizationURL only CONSUMES them — Step-1
    // finding #2), persist them keyed by sha256(state), and hand the raw values to the provider.
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(96).toString("base64url");
    const url = await p.createAuthorizationURL({ state, codeVerifier, redirectURI });
    await stashConnectState(deps.db, { stateHash: sha256(state), codeVerifier, currentUserId: who.accountId, provider });
    res.redirect(302, url.toString());
  };
}

export function connectCallbackShim(deps: ConnectDeps) {
  const resolve: IdentityResolver = deps.resolveIdentity ?? (async (provider, args) => {
    const p = await getConnectProvider(deps.auth, provider);
    if (!p) return null;
    return resolveConnectIdentity(p, { ...args, providerId: provider });
  });
  return async (req: Req, res: Res, next: Next): Promise<void> => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const provider = req.params.provider;
    const row = state ? await consumeConnectState(deps.db, sha256(state)) : null;
    if (!row || row.provider !== provider) { next(); return; }   // not ours -> better-auth handles it
    // Path-based SPA router reads params from window.location.search, so the query MUST sit on the
    // search string (not a hash fragment).
    const dest = `${deps.publicBase}/account`;
    try {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code || typeof req.query.error === "string") { res.redirect(302, `${dest}?connect=error`); return; }
      const ctx = await deps.auth.$context;
      const identity = await resolve(provider, { code, codeVerifier: row.codeVerifier, redirectURI: `${ctx.baseURL}/callback/${provider}` });
      if (!identity) { res.redirect(302, `${dest}?connect=error`); return; }
      const other = await accountIdForProvider(deps.db, identity.providerId, identity.providerAccountId);
      if (other && other !== row.currentUserId) {
        await stashPendingLink(deps.db, row.currentUserId, identity);
        res.redirect(302, `${dest}?connect=ready`);
      } else {
        res.redirect(302, `${dest}?connect=none`);   // unused / already yours (defensive)
      }
    } catch { res.redirect(302, `${dest}?connect=error`); }
  };
}

export function installConnect(expressApp: ExpressApp, deps: ConnectDeps): void {
  expressApp.get("/api/account/connect/:provider", connectStartHandler(deps));
  // MUST be registered before mountAuth's /api/auth/*splat catch-all (see src/index.ts): our state
  // -> we exchange; any foreign state -> next() falls through to better-auth's own callback.
  expressApp.get("/api/auth/callback/:provider", connectCallbackShim(deps));
}
