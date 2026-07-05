// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp.ts
//
// Store + gate for the GitHub App integration: installations (one row per installed org), the
// member lists the webhook/reconcile path syncs from GitHub, and resolveOrgAccess — the combined
// org-access check (self → App membership → captured account_scopes). org_scope/gh_login are
// lowercased at write time so the gate is case-insensitive without lower() on every read.
import { and, eq, sql } from "drizzle-orm";
import { appInstallations, orgMembers, type AppDb } from "./schema.js";
import { accountScopeStatus } from "./webAuth.js";
import { accountScopeRole } from "./orgSettings.js";
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

/** App-synced role for login in orgScope — null unless a NON-suspended installation exists. */
export async function appOrgRole(db: AppDb, login: string, orgScope: string): Promise<"admin" | "member" | null> {
  const scope = orgScope.toLowerCase();
  const inst = await installationForScope(db, scope);
  if (!inst || inst.suspended) return null;
  const rows = await db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.orgScope, scope), eq(orgMembers.ghLogin, login.toLowerCase()))).limit(1);
  return rows.length > 0 ? (rows[0].role === "admin" ? "admin" : "member") : null;
}

export type OrgAccess = { status: "ok" | "stale" | "none"; role: "self" | "admin" | "member" | null; via: "self" | "app" | "scopes" | null };

/**
 * Combined org-access check, in precedence order:
 *   1. self — scope IS the caller's login (their identity; never stale).
 *   2. App membership — webhook-synced, so always fresh; includes private members.
 *   3. Captured account_scopes — today's sign-in capture, with the freshness TTL.
 * Orgs without the App get exactly today's behavior (path 3).
 */
export async function resolveOrgAccess(
  db: AppDb, who: { accountId: string; login: string }, scope: string, scopeTtlMs: number, now: number = Date.now(),
): Promise<OrgAccess> {
  if (who.login.toLowerCase() === scope.toLowerCase()) return { status: "ok", role: "self", via: "self" };
  const appRole = await appOrgRole(db, who.login, scope);
  if (appRole) return { status: "ok", role: appRole, via: "app" };
  const status = await accountScopeStatus(db, who.accountId, scope, scopeTtlMs, now);
  if (status === "none") return { status: "none", role: null, via: null };
  const role = ((await accountScopeRole(db, who.accountId, scope)) ?? "member") as "self" | "admin" | "member";
  return { status, role, via: "scopes" };
}
