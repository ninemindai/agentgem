// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Group endpoints (raw express, like catalog/stars/orgsApi): reachable cross-site, own credentialed
// CORS, originGuard-exempt via the allowlisted /api/catalog/ prefix. Every route is authed (session
// cookie OR Bearer → 401). CSRF on writes is stopped by the SameSite=Lax session cookie plus the
// 401, NOT by CORS: a cross-site form POST carries no Lax cookie, and a cross-site fetch cannot set
// an Authorization header without a preflight this origin allowlist refuses.
//
// Status codes, and why:
//   401  no session
//   404  no such group OR you are not a member — collapsed on purpose. A 403 here would confirm a
//        group exists to a stranger, and this handler will serve ?scope=acme addressing later.
//   403  you ARE a member but not an admin. Existence is already known to you, so nothing leaks.
//   409  refusals that are not about permission: deleting a federated group, removing the last admin.
//   410  the invite expired or was revoked.
//
// Membership is checked against group_members, never against a GitHub login. That is the point of
// the table.
import type { AppDb } from "@agentgem/aggregator";
import {
  resolveSession, createNativeGroup, deleteNativeGroup, listGroupsForAccount, listGroupMembers,
  groupMemberRole, removeMemberGuarded,
  createGroupInvite, redeemGroupInvite, revokeGroupInvite, listGroupInvites,
  type GroupRole,
} from "@agentgem/aggregator";
import { SESSION_COOKIE, parseCookies } from "../auth/cookie.js";

export interface GroupsDeps { db: AppDb; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = {
  get(p: string, h: (req: Req, res: Res) => unknown): unknown;
  post(p: string, h: (req: Req, res: Res) => unknown): unknown;
  delete(p: string, h: (req: Req, res: Res) => unknown): unknown;
  options(p: string, h: (req: Req, res: Res) => unknown): unknown;
};

const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;
const MAX_GROUP_NAME = 80;

// groups/group_members/group_invites id and account columns are all `uuid`. A malformed value
// makes Postgres reject the query and the promise reject, which Express 5 forwards to the default
// error handler → 500 with a stack trace. Reject the shape before it ever reaches a query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send("");
}

async function whoami(deps: GroupsDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const auth = req.headers["authorization"];
  const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const token = bearer || parseCookies(req.headers["cookie"])[SESSION_COOKIE];
  const who = token ? await resolveSession(deps.db, token) : null;
  return who ? { accountId: who.accountId, login: who.login } : null;
}

async function requireSession(deps: GroupsDeps, req: Req, res: Res): Promise<{ accountId: string; login: string } | null> {
  const who = await whoami(deps, req);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  return who;
}

/** The group gate. Note there is no getGroup() call: a group you are not in is indistinguishable
 *  from one that does not exist, which is both the security property and one fewer query. */
async function requireGroupRole(
  deps: GroupsDeps, req: Req, res: Res, needAdmin: boolean,
): Promise<{ accountId: string; groupId: string; role: GroupRole } | null> {
  const who = await requireSession(deps, req, res);
  if (!who) return null;
  const groupId = String((req.query.id as string | undefined) ?? "");
  if (!groupId) { res.status(400).json({ error: "id required" }); return null; }
  if (!UUID_RE.test(groupId)) { res.status(400).json({ error: "id must be a UUID" }); return null; }
  const role = await groupMemberRole(deps.db, groupId, who.accountId);
  if (!role) { res.status(404).json({ error: "group not found" }); return null; }
  if (needAdmin && role !== "admin") { res.status(403).json({ error: "group admin required" }); return null; }
  return { accountId: who.accountId, groupId, role };
}

/** GET → my groups. POST {name} → create native. DELETE ?id= → delete native (admin). */
export function groupsHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }

    if (req.method === "DELETE") {
      const ok = await requireGroupRole(deps, req, res, true);
      if (!ok) return;
      const result = await deleteNativeGroup(deps.db, ok.groupId);
      if (result === "federated") { res.status(409).json({ error: "managed by the GitHub App installation" }); return; }
      if (result === "not-found") { res.status(404).json({ error: "group not found" }); return; }
      res.json({ deleted: true });
      return;
    }

    const who = await requireSession(deps, req, res);
    if (!who) return;

    if (req.method === "POST") {
      const name = String((req.body.name as string | undefined) ?? "").trim();
      if (!name || name.length > MAX_GROUP_NAME) { res.status(400).json({ error: `name required (1-${MAX_GROUP_NAME} chars)` }); return; }
      res.json({ group: await createNativeGroup(deps.db, who.accountId, name) });
      return;
    }
    res.json({ groups: await listGroupsForAccount(deps.db, who.accountId) });
  };
}

/** GET → members (any member). DELETE ?account= → remove (admin, or yourself). */
export function groupMembersHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, false);
    if (!ok) return;

    if (req.method === "DELETE") {
      const target = String((req.query.account as string | undefined) ?? "");
      if (!target) { res.status(400).json({ error: "account required" }); return; }
      if (!UUID_RE.test(target)) { res.status(400).json({ error: "account must be a UUID" }); return; }
      const isSelf = target === ok.accountId;
      if (!isSelf && ok.role !== "admin") { res.status(403).json({ error: "group admin required" }); return; }
      const result = await removeMemberGuarded(deps.db, ok.groupId, target);
      if (result === "not-member") { res.status(404).json({ error: "not a member" }); return; }
      if (result === "last-admin") { res.status(409).json({ error: "a group must keep at least one admin" }); return; }
      res.json({ removed: true });
      return;
    }
    res.json({ members: await listGroupMembers(deps.db, ok.groupId) });
  };
}

/** GET → outstanding invites (ids). POST → mint. DELETE ?invite= → revoke. All admin-only. */
export function groupInvitesHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const ok = await requireGroupRole(deps, req, res, true);
    if (!ok) return;

    if (req.method === "DELETE") {
      const inviteId = String((req.query.invite as string | undefined) ?? "");
      if (!inviteId) { res.status(400).json({ error: "invite required" }); return; }
      if (!UUID_RE.test(inviteId)) { res.status(400).json({ error: "invite must be a UUID" }); return; }
      if (!(await revokeGroupInvite(deps.db, ok.groupId, inviteId))) { res.status(404).json({ error: "invite not found" }); return; }
      res.json({ revoked: true });
      return;
    }

    if (req.method === "POST") {
      const role: GroupRole = req.body.role === "admin" ? "admin" : "member";
      const requested = Number(req.body.ttlDays ?? DEFAULT_INVITE_TTL_DAYS);
      const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_INVITE_TTL_DAYS) : DEFAULT_INVITE_TTL_DAYS;
      // The raw token is returned exactly once, here, and never stored or logged.
      res.json(await createGroupInvite(deps.db, { groupId: ok.groupId, role, createdBy: ok.accountId, ttlMs: days * 86_400_000 }));
      return;
    }
    res.json({ invites: await listGroupInvites(deps.db, ok.groupId) });
  };
}

/** POST {token} → join. Any signed-in user may redeem; the token IS the authorization. */
export function groupInviteRedeemHandler(deps: GroupsDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const who = await requireSession(deps, req, res);
    if (!who) return;
    const token = String((req.body.token as string | undefined) ?? "");
    if (!token) { res.status(400).json({ error: "token required" }); return; }
    const result = await redeemGroupInvite(deps.db, token, who.accountId);
    if (result === "not-found") { res.status(404).json({ error: "invite not found" }); return; }
    if (result === "gone") { res.status(410).json({ error: "this invite has expired or been revoked" }); return; }
    res.json({ joined: true });
  };
}

export function installGroups(expressApp: ExpressApp, deps: GroupsDeps): void {
  for (const [path, handler] of [
    ["/api/catalog/groups", groupsHandler(deps)],
    ["/api/catalog/group-members", groupMembersHandler(deps)],
    ["/api/catalog/group-invites", groupInvitesHandler(deps)],
    ["/api/catalog/group-invite-redeem", groupInviteRedeemHandler(deps)],
  ] as const) {
    expressApp.get(path, handler);
    expressApp.post(path, handler);
    expressApp.delete(path, handler);
    expressApp.options(path, handler);
  }
}
