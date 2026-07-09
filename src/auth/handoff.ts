// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Desktop→web SSO handoff (relocated out of auth/install.ts ahead of its Task-5 deletion — see
// AuthDeps there for the pre-cutover version this replaces). The local app, authenticated with its
// own better-auth session, mints a single-use handoff code; the browser opens the redeem URL and
// swaps that code for a GENUINE better-auth session cookie — minted via mintSessionCookie
// (@agentgem/aggregator/auth/mintCookie.ts), which drives real better-auth endpoints in-process
// rather than hand-signing a cookie. Raw express routes (302 + Set-Cookie), outside originGuard;
// registered in src/index.ts BEFORE better-auth's own catch-all mount so it can never swallow them
// (see installHandoff below for the exact paths and why they don't collide with better-auth's own).
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { createHandoffCode, redeemHandoffCode, resolveSession, getAccountById, ensureBetterAuthUser, mintSessionCookie } from "@agentgem/aggregator";
import { createLogger } from "@agentgem/base";

const log = createLogger("auth");

export interface HandoffConfig { webOrigins: string[] }
export interface HandoffDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; config: HandoffConfig }

// duck-typed Express req/res (no @types/express dependency, matching auth/install.ts / groups/install.ts)
interface Req { method: string; query: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; setHeader(k: string, v: string): Res; json(b: unknown): Res; redirect(code: number, url?: string): Res }
type ExpressApp = { get(path: string, h: (req: Req, res: Res) => unknown): unknown; post(path: string, h: (req: Req, res: Res) => unknown): unknown };

const HANDOFF_TTL_MS = 60 * 1000;

const firstWebOrigin = (cfg: HandoffConfig): string => cfg.webOrigins[0] ?? "/";

/** Return the allowlisted return URL, or the first web origin if `ret` is missing/invalid — the
 *  open-redirect guard: redeem never 302s to an off-allowlist target. */
export function safeReturn(cfg: HandoffConfig, ret: string | undefined): string {
  if (ret && cfg.webOrigins.some((o) => ret === o || ret.startsWith(o + "/"))) return ret;
  return firstWebOrigin(cfg);
}

/** Desktop→web SSO, step 1: the local app (its own better-auth session, presented as a Bearer
 *  header or cookie — resolveSession accepts either) mints a single-use handoff code. Server-to-
 *  server call (no browser), so no CORS. 401 when no valid session is presented. */
export function handoffStartHandler(deps: HandoffDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "unauthenticated" }); return; }
    const { code, expiresAt } = await createHandoffCode(deps.db, who.accountId, HANDOFF_TTL_MS);
    res.json({ code, expiresAt });
  };
}

/** Desktop→web SSO, step 2: the browser opens this with ?code=&return=. Redeem the code (single-
 *  use, delete-on-read), then hand the browser a genuine better-auth session cookie for the bound
 *  account (mintSessionCookie — never hand-signed), and 302 to an allowlisted return (safeReturn
 *  blocks open redirects). Invalid/expired/used code, or any failure minting the cookie, → 302 with
 *  ?auth_error=handoff and no Set-Cookie. */
export function handoffRedeemHandler(deps: HandoffDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    const code = String((req.query.code as string | undefined) ?? "");
    const dest = safeReturn(deps.config, req.query.return as string | undefined);
    const accountId = code ? await redeemHandoffCode(deps.db, code) : null;
    if (!accountId) { res.redirect(302, `${dest}?auth_error=handoff`); return; }
    try {
      const account = await getAccountById(deps.db, accountId);
      if (!account) throw new Error("handoff: account not found");
      await ensureBetterAuthUser(deps.db, account);
      const cookie = await mintSessionCookie(deps.auth, account.id);
      res.setHeader("Set-Cookie", cookie);
      res.redirect(302, dest);
    } catch (err) {
      log.error("handoff redeem failed: %s", (err as Error)?.message ?? err);
      res.redirect(302, `${dest}?auth_error=handoff`);
    }
  };
}

// Route paths, and why they're safe: better-auth (mounted via mountAuth's `${prefix}/*splat`
// catch-all) serves sign-in/*, sign-up/*, sign-out, get-session, callback/*, one-time-token/* etc
// under its own prefix — "handoff/start" and "handoff/redeem" don't collide with any of those.
// Once Task 5 flips mountAuth's prefix from the transitional "/api/betterauth" to "/api/auth",
// these two paths would sit UNDER better-auth's own catch-all namespace, so src/index.ts MUST
// register installHandoff(...) before mountAuth(...) — Express dispatches to the first matching
// route registered, so registering these first means better-auth's catch-all never even sees them.
export function installHandoff(expressApp: ExpressApp, deps: HandoffDeps): void {
  expressApp.post("/api/auth/handoff/start", handoffStartHandler(deps));
  expressApp.get("/api/auth/handoff/redeem", handoffRedeemHandler(deps));
}
