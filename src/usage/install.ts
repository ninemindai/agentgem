// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Team usage endpoints (raw express, like stars/install.ts): reachable cross-site, own credentialed
// CORS, originGuard-exempt via the /api/usage prefix. All are authed (session → 401):
//   POST /api/usage/report   — the local agentgem process pushes daily + per-model rollups (Bearer).
//   GET  /api/usage/org      — the org dashboard read; 403 unless the caller's captured scopes
//                              (account_scopes, from GitHub org membership at sign-in) include it.
//   GET  /api/usage/settings — org settings read (member); PUT-via-POST writes are ADMIN-gated on
//                              the GitHub org role captured into account_scopes.
//   Gates consult resolveOrgAccess (App-authoritative): an active GitHub App installation decides
//   membership alone; otherwise the captured account_scopes (TTL'd) apply.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import {
  resolveSession, resolveOrgAccess, accountSelfScope, normalizeUsageReport, normalizeUsageModels, recordUsageDays, recordUsageModels,
  buildOrgUsage, getOrgSettings, putOrgSettings, normalizeRetentionDays, applyRetentionForScopes,
  RANGE_DAYS, type OrgUsageRange,
} from "@agentgem/aggregator";

export interface UsageDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[]; scopeTtlMs?: number }

// Membership grants are only re-captured from GitHub at sign-in/bind, so bound revocation lag by
// refusing grants older than this: the member still matched, but must refresh (one-click re-auth
// for an already-authorized OAuth app) before reading again. Override via AGENTGEM_SCOPE_TTL_DAYS.
export function defaultScopeTtlMs(): number {
  const days = Number(process.env.AGENTGEM_SCOPE_TTL_DAYS ?? 7);
  return (Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000;
}

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined>; get(n: string): string | undefined }
interface Res { status(c: number): Res; set(k: string, v: string): Res; setHeader(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { get(p: string, h: (req: Req, res: Res) => unknown): unknown; post(p: string, h: (req: Req, res: Res) => unknown): unknown; put(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send("");
}

/** Session from `Authorization: Bearer <token>` (local process) OR the web session cookie —
 *  better-auth reads whichever is present off the forwarded headers. */
async function whoami(deps: UsageDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who ? { accountId: who.accountId, login: who.login } : null;
}

// The caller's own dashboard = they hold the role='self' scope row for `scope`. Never a login
// string compare: a login-less user's "" would equal no valid scope, silently routing every
// personal request through the org gate. Case-insensitive (accountSelfScope): the `scope` query
// param can carry different casing than the stored handle (GitHub logins are case-insensitive in
// URLs), and must still match the row the caller holds.
const isSelfScope = async (deps: UsageDeps, accountId: string, scope: string): Promise<boolean> =>
  accountSelfScope(deps.db, accountId, scope);

export function reportHandler(deps: UsageDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await whoami(deps, req);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const report = normalizeUsageReport(req.body ?? {});
    if (!report) { res.status(400).json({ error: "invalid report" }); return; }
    const out = await recordUsageDays(deps.db, who.accountId, report.machine, report.days);
    const models = normalizeUsageModels((req.body ?? {}).models);
    if (models.length > 0) await recordUsageModels(deps.db, who.accountId, report.machine, models);
    // Post-ingest retention: enforce each configured org's window on exactly the scopes this
    // report touched — keeps retention live without a background job.
    await applyRetentionForScopes(deps.db, report.days.map((d) => d.scope));
    res.json(out);
  };
}

/** The shared membership gate. resolveOrgAccess is App-authoritative: an org with an active
 *  GitHub App installation is decided by App-synced membership alone (removal on GitHub revokes
 *  in seconds); otherwise the captured account_scopes answer ownership, freshness (bounding
 *  revocation lag), and role. Writes the 403 (with the reason the UI branches on) itself and
 *  returns null; a handler that skips this gate cannot exist. */
async function memberGate(deps: UsageDeps, res: Res, who: { accountId: string; login: string }, scope: string): Promise<{ role: string } | null> {
  const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
  if (access.status === "none") { res.status(403).json({ error: "not a member of this org" }); return null; }
  if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again to refresh", reason: "stale" }); return null; }
  return { role: access.role ?? "member" };
}

/** GET (member) / PUT (admin) of the org's dashboard settings. Uses the GitHub org role captured
 *  into account_scopes — the first role-gated write surface. */
export function orgSettingsHandler(deps: UsageDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await whoami(deps, req);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const scope = String((req.query.scope as string | undefined) ?? "").trim();
    if (scope.length === 0 || scope.length > 100) { res.status(400).json({ error: "invalid scope" }); return; }
    const gate = await memberGate(deps, res, who, scope);
    if (!gate) return;
    const { role } = gate;

    if (req.method === "PUT") {
      // Admins write org policy; "self" writes their own-login scope (personal retention).
      if (role !== "admin" && role !== "self") { res.status(403).json({ error: "org admins only" }); return; }
      // PARTIAL update: fields absent from the body keep their stored value. This is what makes
      // concurrent admins safe (changing retention can't clobber a visibility flip made from
      // another tab) and keeps retention-only clients (pre-toggle bundles) working.
      const body = req.body ?? {};
      const current = await getOrgSettings(deps.db, scope);
      let retentionDays = current.retentionDays;
      if ("retentionDays" in body) {
        const norm = normalizeRetentionDays(body.retentionDays);
        if (norm === undefined) { res.status(400).json({ error: "retentionDays must be null or 7–730" }); return; }
        retentionDays = norm;
      }
      let dashboardEnabled = current.dashboardEnabled;
      if ("dashboardEnabled" in body) {
        if (typeof body.dashboardEnabled !== "boolean") { res.status(400).json({ error: "dashboardEnabled must be a boolean" }); return; }
        dashboardEnabled = body.dashboardEnabled;
      }
      const saved = await putOrgSettings(deps.db, scope, { retentionDays, dashboardEnabled }, who.login);
      res.json({ ...saved, viewerRole: role });
      return;
    }
    res.json({ ...(await getOrgSettings(deps.db, scope)), viewerRole: role });
  };
}

export function orgUsageHandler(deps: UsageDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await whoami(deps, req);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }
    const scope = String((req.query.scope as string | undefined) ?? "").trim();
    const range = String((req.query.range as string | undefined) ?? "7d");
    if (scope.length === 0 || scope.length > 100 || !(range in RANGE_DAYS)) { res.status(400).json({ error: "invalid scope or range" }); return; }
    // Internal dashboard: the caller must be a member of the org (captured at sign-in/bind), and
    // the capture must be fresh — a stale grant 403s with reason "stale" so the UI can offer a
    // one-click membership refresh instead of a dead end. The caller's own claimed scope is exempt
    // from freshness (it IS their identity), so /api/usage/org?scope=<their-handle> stays personal.
    const isSelf = await isSelfScope(deps, who.accountId, scope);
    if (!isSelf) {
      // The settings read is independent of the gate — overlap them instead of stacking.
      const [gate, settings] = await Promise.all([
        memberGate(deps, res, who, scope),
        getOrgSettings(deps.db, scope),
      ]);
      if (!gate) return;
      // Visibility toggle: an org admin can switch the dashboard off for members. Admins still
      // see it (they control the toggle and need the settings footer to flip it back). The
      // personal view (scope = own login) is never affected by org policy.
      if (!settings.dashboardEnabled && gate.role !== "admin") {
        res.status(403).json({ error: "dashboard disabled by an org admin", reason: "disabled" });
        return;
      }
    }
    // Optional facets: narrow to one member (drill-down) and/or one agent/model. All compose,
    // and all stay inside the org-scope attribution boundary.
    const member = String((req.query.member as string | undefined) ?? "").trim();
    const agent = String((req.query.agent as string | undefined) ?? "").trim();
    const model = String((req.query.model as string | undefined) ?? "").trim();
    if (member.length > 100 || agent.length > 100 || model.length > 100) { res.status(400).json({ error: "invalid filter" }); return; }
    // Personal view folds in unattributed ("") rows — sessions outside any repo are still the
    // caller's own work. Org views stay strictly scope-attributed (the anti-leak boundary).
    res.json(await buildOrgUsage(deps.db, scope, range as OrgUsageRange, Date.now(), {
      includeUnattributed: isSelf,
      ...(member ? { memberLogin: member } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    }));
  };
}

export function installUsage(expressApp: ExpressApp, deps: UsageDeps): void {
  expressApp.post("/api/usage/report", reportHandler(deps));
  expressApp.get("/api/usage/org", orgUsageHandler(deps));
  expressApp.get("/api/usage/settings", orgSettingsHandler(deps));
  expressApp.put("/api/usage/settings", orgSettingsHandler(deps));
  expressApp.options("/api/usage/report", reportHandler(deps));
  expressApp.options("/api/usage/org", orgUsageHandler(deps));
  expressApp.options("/api/usage/settings", orgSettingsHandler(deps));
}
