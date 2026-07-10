// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp.ts
//
// Store + gate for the GitHub App integration: installations (one row per installed org), the
// member lists the webhook/reconcile path syncs from GitHub, and resolveOrgAccess — the combined
// org-access check (self → App-authoritative membership when an active installation exists,
// else captured account_scopes). org_scope/gh_login are lowercased at write time so the gate is
// case-insensitive without lower() on every read.
import { and, eq, sql } from "drizzle-orm";
import { appInstallations, orgMembers, type AppDb } from "./schema.js";
import { accountScopeStatus } from "./webAuth.js";
import { accountScopeRole, accountSelfScope } from "./orgSettings.js";
import { deleteOrgSkills } from "./curatedSkills.js";

export interface AppInstallation { installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }

export async function upsertInstallation(db: AppDb, inst: AppInstallation): Promise<void> {
  const orgScope = inst.orgScope.toLowerCase();
  await db.insert(appInstallations)
    .values({ installationId: inst.installationId, orgScope, repoSelection: inst.repoSelection, suspended: inst.suspended })
    .onConflictDoUpdate({
      target: appInstallations.installationId,
      set: { orgScope, repoSelection: inst.repoSelection, suspended: inst.suspended, updatedAt: sql`now()` },
    });
}

export async function setInstallationSuspended(db: AppDb, installationId: number, suspended: boolean): Promise<void> {
  await db.update(appInstallations).set({ suspended, updatedAt: sql`now()` }).where(eq(appInstallations.installationId, installationId));
}

/** Uninstall = forget: the installation row, its synced members, and its private skill rows. */
export async function deleteInstallation(db: AppDb, installationId: number): Promise<void> {
  const rows = await db.select({ orgScope: appInstallations.orgScope }).from(appInstallations)
    .where(eq(appInstallations.installationId, installationId)).limit(1);
  const orgScope = rows[0]?.orgScope;
  await db.delete(appInstallations).where(eq(appInstallations.installationId, installationId));
  if (orgScope) {
    await db.delete(orgMembers).where(eq(orgMembers.orgScope, orgScope));
    await deleteOrgSkills(db, orgScope);
  }
}

export async function installationForScope(db: AppDb, orgScope: string): Promise<AppInstallation | null> {
  const rows = await db.select().from(appInstallations).where(eq(appInstallations.orgScope, orgScope.toLowerCase())).limit(1);
  const r = rows[0];
  return r ? { installationId: r.installationId, orgScope: r.orgScope, repoSelection: r.repoSelection as "all" | "selected", suspended: r.suspended } : null;
}

export async function listInstallations(db: AppDb): Promise<AppInstallation[]> {
  const rows = await db.select().from(appInstallations);
  return rows.map((r) => ({ installationId: r.installationId, orgScope: r.orgScope, repoSelection: r.repoSelection as "all" | "selected", suspended: r.suspended }));
}

export async function replaceOrgMembers(db: AppDb, orgScope: string, members: { login: string; role: "admin" | "member" }[]): Promise<void> {
  const scope = orgScope.toLowerCase();
  await db.delete(orgMembers).where(eq(orgMembers.orgScope, scope));
  if (members.length > 0) {
    await db.insert(orgMembers).values(members.map((m) => ({ orgScope: scope, ghLogin: m.login.toLowerCase(), role: m.role })));
  }
}

export async function upsertOrgMember(db: AppDb, orgScope: string, login: string, role: "admin" | "member"): Promise<void> {
  await db.insert(orgMembers)
    .values({ orgScope: orgScope.toLowerCase(), ghLogin: login.toLowerCase(), role })
    .onConflictDoUpdate({ target: [orgMembers.orgScope, orgMembers.ghLogin], set: { role, syncedAt: sql`now()` } });
}

export async function deleteOrgMember(db: AppDb, orgScope: string, login: string): Promise<void> {
  await db.delete(orgMembers).where(and(eq(orgMembers.orgScope, orgScope.toLowerCase()), eq(orgMembers.ghLogin, login.toLowerCase())));
}

/** org_members lookup only — caller has already resolved (and validated) the installation. */
async function memberRole(db: AppDb, login: string, orgScope: string): Promise<"admin" | "member" | null> {
  const rows = await db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.orgScope, orgScope), eq(orgMembers.ghLogin, login.toLowerCase()))).limit(1);
  return rows.length > 0 ? (rows[0].role === "admin" ? "admin" : "member") : null;
}

/** App-synced role for login in orgScope — null unless a NON-suspended installation exists. */
export async function appOrgRole(db: AppDb, login: string, orgScope: string): Promise<"admin" | "member" | null> {
  const scope = orgScope.toLowerCase();
  const inst = await installationForScope(db, scope);
  if (!inst || inst.suspended) return null;
  return memberRole(db, login, scope);
}

export type OrgAccess = { status: "ok" | "stale" | "none"; role: "self" | "admin" | "member" | null; via: "self" | "app" | "scopes" | null };

/**
 * Combined org-access check, in precedence order:
 *   1. self — the caller HOLDS the role='self' account_scopes row for scope (their claimed
 *      handle; never stale), matched case-insensitively (GitHub logins/handles are
 *      case-insensitive). Never a login-string match: claiming a name is not the grant.
 *   2. App-authoritative — when the scope has an ACTIVE (non-suspended) installation,
 *      webhook-synced App membership decides ALONE: in org_members → "ok", otherwise "none".
 *      Captured account_scopes are NOT consulted in this case. Rationale: on GitHub, removing a
 *      member from an org revokes them within seconds via the webhook sync; a captured sign-in
 *      scope must not keep granting access for up to its TTL afterward — that would defeat
 *      enterprise offboarding for anyone who happened to sign in recently.
 *   3. Captured account_scopes — today's sign-in capture, with the freshness TTL. Reached only
 *      when there is no active installation (App not installed, or installation suspended — a
 *      suspended installation behaves as uninstalled for gating purposes).
 * Orgs without the App get exactly today's behavior (path 3).
 */
export async function resolveOrgAccess(
  db: AppDb, who: { accountId: string; login: string }, scope: string, scopeTtlMs: number, now: number = Date.now(),
): Promise<OrgAccess> {
  // Self is HOLDING the role='self' scope row (written by claimHandle, which runs the reserved-org
  // guard), never a login-string match. A string compare would grant `self` on "" === "" for two
  // login-less accounts, and would let a freely-claimed name become a grant. Case-insensitive
  // (accountSelfScope, not accountScopeRole): GitHub treats logins case-insensitively in URLs, and
  // the stored handle keeps whatever casing the user claimed — a scope param with different casing
  // must still match the row the caller holds.
  if (await accountSelfScope(db, who.accountId, scope)) {
    return { status: "ok", role: "self", via: "self" };
  }
  const scopeLower = scope.toLowerCase();
  const inst = await installationForScope(db, scopeLower);
  if (inst && !inst.suspended) {
    const role = await memberRole(db, who.login, scopeLower);
    return role ? { status: "ok", role, via: "app" } : { status: "none", role: null, via: "app" };
  }
  const status = await accountScopeStatus(db, who.accountId, scope, scopeTtlMs, now);
  if (status === "none") return { status: "none", role: null, via: null };
  const role = ((await accountScopeRole(db, who.accountId, scope)) ?? "member") as "self" | "admin" | "member";
  return { status, role, via: "scopes" };
}
