// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web sign-in: four RAW express routes (302 + Set-Cookie + cookie reads, which the decorator
// framework can't do). Raw routes are OUTSIDE originGuard (like /healthz), so they set their own
// credentialed CORS for the AGENTGEM_WEB_ORIGINS allowlist. SameSite=Lax + the OAuth `state` are the
// CSRF defenses (a cross-site POST carries no session cookie under Lax).
import type { AppDb, AccountVerifier } from "@agentgem/aggregator";
import { upsertAccount, createSession, deleteSession, resolveSession, generateSessionToken } from "@agentgem/aggregator";
import { signState, verifyState } from "./state.js";
import { SESSION_COOKIE, parseCookies, serializeSessionCookie, clearSessionCookie } from "./cookie.js";

export interface AuthConfig {
  clientId: string; clientSecret: string; webOrigins: string[];
  cookieDomain?: string; callbackUrl: string; stateSecret: string; sessionTtlMs: number;
}
export interface AuthDeps { db: AppDb; verifier: AccountVerifier; exchangeCode: (code: string) => Promise<string>; config: AuthConfig }

// duck-typed Express req/res (no @types/express dependency, matching originGuard / the SSE handlers)
interface Req { method: string; path: string; query: Record<string, unknown>; headers: Record<string, string | undefined>; get(name: string): string | undefined }
interface Res { status(c: number): Res; set(k: string, v: string): Res; setHeader(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res; redirect(code: number, url?: string): Res }
type ExpressApp = { get(path: string, h: (req: Req, res: Res) => unknown): unknown; post(path: string, h: (req: Req, res: Res) => unknown): unknown; options(path: string, h: (req: Req, res: Res) => unknown): unknown };

const STATE_TTL_MS = 10 * 60 * 1000;

/** Echo credentialed CORS for an allowlisted Origin (wildcard is illegal with credentials). */
function authCors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}

const firstWebOrigin = (cfg: AuthConfig): string => cfg.webOrigins[0] ?? "/";

export function loginHandler(deps: AuthDeps) {
  return (req: Req, res: Res): void => {
    const ret = String((req.query.return as string | undefined) ?? "");
    if (!deps.config.webOrigins.some((o) => ret === o || ret.startsWith(o + "/"))) {
      res.status(400).json({ error: "invalid return url" });
      return;
    }
    const state = signState({ returnTo: ret }, deps.config.stateSecret, Date.now());
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", deps.config.clientId);
    u.searchParams.set("redirect_uri", deps.config.callbackUrl);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", state);
    res.redirect(302, u.toString());
  };
}

export function callbackHandler(deps: AuthDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const code = String((req.query.code as string | undefined) ?? "");
    const state = String((req.query.state as string | undefined) ?? "");
    const v = verifyState(state, deps.config.stateSecret, Date.now(), STATE_TTL_MS);
    const fallback = firstWebOrigin(deps.config);
    if (!v || !code) { res.redirect(302, `${fallback}?auth_error=state`); return; }
    try {
      const token = await deps.exchangeCode(code);
      const acct = await deps.verifier.verify(token);
      const row = await upsertAccount(deps.db, { provider: acct.provider, accountId: acct.accountId, login: acct.login });
      const { token: sessionToken } = generateSessionToken();
      await createSession(deps.db, row.id, sessionToken, deps.config.sessionTtlMs);
      res.setHeader("Set-Cookie", serializeSessionCookie(sessionToken, { domain: deps.config.cookieDomain, maxAgeSec: Math.floor(deps.config.sessionTtlMs / 1000) }));
      res.redirect(302, v.returnTo);
    } catch {
      res.redirect(302, `${fallback}?auth_error=exchange`);
    }
  };
}

export function meHandler(deps: AuthDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    authCors(req, res, deps.config.webOrigins);
    if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send(""); return; }
    const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
    const who = token ? await resolveSession(deps.db, token) : null;
    if (!who) { res.json({ authenticated: false }); return; }
    res.json({ login: who.login, avatarUrl: who.avatarUrl });
  };
}

export function logoutHandler(deps: AuthDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    authCors(req, res, deps.config.webOrigins);
    if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send(""); return; }
    const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
    if (token) await deleteSession(deps.db, token);
    res.setHeader("Set-Cookie", clearSessionCookie({ domain: deps.config.cookieDomain }));
    res.json({ ok: true });
  };
}

/** The real GitHub authorization-code exchange. */
export function githubExchangeCode(clientId: string, clientSecret: string): (code: string) => Promise<string> {
  return async (code: string): Promise<string> => {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) throw new Error(`github token exchange: ${res.status}`);
    const j = (await res.json()) as { access_token?: unknown };
    if (typeof j.access_token !== "string") throw new Error("github token exchange: no access_token");
    return j.access_token;
  };
}

export function installAuth(expressApp: ExpressApp, deps: AuthDeps): void {
  expressApp.get("/api/auth/github/login", loginHandler(deps));
  expressApp.get("/api/auth/github/callback", callbackHandler(deps));
  expressApp.get("/api/auth/me", meHandler(deps));
  expressApp.post("/api/auth/logout", logoutHandler(deps));
  // CORS preflight: browsers send OPTIONS for credentialed cross-origin XHR; Express won't route it
  // to the GET/POST handlers, so register it explicitly. The handlers' OPTIONS branch answers 204+CORS.
  expressApp.options("/api/auth/me", meHandler(deps));
  expressApp.options("/api/auth/logout", logoutHandler(deps));
}
