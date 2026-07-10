// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertAccount, setAccountScopes,
  upsertInstallation, setInstallationSuspended, deleteInstallation, installationForScope, listInstallations,
  replaceOrgMembers, upsertOrgMember, deleteOrgMember, appOrgRole, resolveOrgAccess,
  orgMembers,
} from "@agentgem/aggregator";

const inst = (over: Partial<{ installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }> = {}) =>
  ({ installationId: 101, orgScope: "acme", repoSelection: "selected" as const, suspended: false, ...over });

describe("app installations store", () => {
  it("upserts, lists, suspends, and re-upserts idempotently", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await upsertInstallation(db, inst({ repoSelection: "all" })); // update, not duplicate
    expect(await listInstallations(db)).toEqual([inst({ repoSelection: "all" })]);
    await setInstallationSuspended(db, 101, true);
    expect((await installationForScope(db, "acme"))?.suspended).toBe(true);
    expect(await installationForScope(db, "ACME")).not.toBeNull(); // scope compare is case-insensitive
    expect(await installationForScope(db, "other")).toBeNull();
  });

  it("deleteInstallation removes the row and its members", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "admin" }]);
    await deleteInstallation(db, 101);
    expect(await listInstallations(db)).toEqual([]);
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
    expect(await db.select().from(orgMembers)).toEqual([]); // cascade pinned at the row level, not via the gate
  });
});

describe("org members store", () => {
  it("replaceOrgMembers replaces atomically; single-row deltas work; lookups lowercase", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "Alice", role: "admin" }, { login: "bob", role: "member" }]);
    expect(await appOrgRole(db, "ALICE", "Acme")).toBe("admin");
    await replaceOrgMembers(db, "acme", [{ login: "bob", role: "member" }]); // alice gone
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
    await upsertOrgMember(db, "acme", "Carol", "member");
    expect(await appOrgRole(db, "carol", "acme")).toBe("member");
    await deleteOrgMember(db, "acme", "CAROL");
    expect(await appOrgRole(db, "carol", "acme")).toBeNull();
  });

  it("appOrgRole requires an active (non-suspended) installation", async () => {
    const db = await makeTestDb();
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "member" }]); // no installation row at all
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
    await upsertInstallation(db, inst());
    expect(await appOrgRole(db, "alice", "acme")).toBe("member");
    await setInstallationSuspended(db, 101, true);
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
  });
});

describe("resolveOrgAccess", () => {
  it("grants self from the role='self' scope row, not from a login string match", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await setAccountScopes(db, a.id, [{ scope: "alice", role: "self" }]);
    // holds the row → self
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "alice", 1000)).toEqual({ status: "ok", role: "self", via: "self" });

    // a DIFFERENT account whose login string is also "alice" but holds NO role='self' row must not
    // be granted self — claiming/having that login string is not the grant, holding the row is.
    const bare = await upsertAccount(db, { provider: "github", accountId: "2", login: "alice" });
    expect(await resolveOrgAccess(db, { accountId: bare.id, login: "alice" }, "alice", 1000)).toEqual({ status: "none", role: null, via: null });

    // Task 8 security property still holds in any casing: a login string that matches the scope
    // but holds NO role='self' row still gets "none" — never revived as a login compare.
    const bareUpper = await upsertAccount(db, { provider: "github", accountId: "3", login: "ALICE" });
    expect(await resolveOrgAccess(db, { accountId: bareUpper.id, login: "ALICE" }, "ALICE", 1000)).toEqual({ status: "none", role: null, via: null });
  });

  // Fix pass (Task 7/8 review — case sensitivity), Finding 1: GitHub treats logins
  // case-insensitively in URLs, so a scope param with different casing than the stored handle
  // must still match the role='self' row the caller holds.
  it("grants self case-insensitively: a role='self' row for 'raymond' matches scope 'RayMond'", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "raymond" });
    await setAccountScopes(db, a.id, [{ scope: "raymond", role: "self" }]);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "raymond" }, "RayMond", 1000)).toEqual({ status: "ok", role: "self", via: "self" });
  });

  it("two login-less accounts do not collide on the empty scope", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: null });
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "" }, "", 1000)).toEqual({ status: "none", role: null, via: null });

    // Same property, uppercased scope: still no collision (lower("") === lower("") would still be
    // vacuously true here, but there is no role='self' row for either account to match against).
    const b = await upsertAccount(db, { provider: "github", accountId: "2", login: null });
    expect(await resolveOrgAccess(db, { accountId: b.id, login: "" }, "", 1000)).toEqual({ status: "none", role: null, via: null });
  });

  it("app membership passes without any captured scope (and beats stale scopes)", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "admin" }]);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 1000)).toEqual({ status: "ok", role: "admin", via: "app" });
  });

  it("falls back to captured scopes with freshness; none when neither source matches", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await setAccountScopes(db, a.id, ["alice", { scope: "acme", role: "member" }]);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 60_000)).toEqual({ status: "ok", role: "member", via: "scopes" });
    expect((await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 60_000, Date.now() + 120_000)).status).toBe("stale");
    expect((await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "globex", 60_000)).status).toBe("none");
  });

  it("active installation is authoritative — a removed member's fresh captured scope no longer grants access", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await setAccountScopes(db, a.id, ["alice", { scope: "acme", role: "member" }]); // fresh capture
    await upsertInstallation(db, inst()); // active installation
    // alice is NOT in org_members — removed from the org on GitHub since she signed in.
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 60_000)).toEqual({ status: "none", role: null, via: "app" });
  });

  it("suspended installation falls back to captured scopes", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await setAccountScopes(db, a.id, ["alice", { scope: "acme", role: "member" }]);
    await upsertInstallation(db, inst());
    await setInstallationSuspended(db, 101, true); // suspended = no active installation
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 60_000)).toEqual({ status: "ok", role: "member", via: "scopes" });
  });

  // Final-review Finding 1: a role='self' row for an org's name (claimed before the org ever
  // installed the App — isReserved in handles.ts only blocks names an org has ALREADY written a
  // row for) must not preempt the App roster once an active installation exists. Before the
  // re-key this was structurally impossible: self was `who.login === scope`, and GitHub's shared
  // user/org namespace means a login can never equal an org name.
  it("App-authoritative membership preempts a squatted self row: role='self' on 'acme' does not survive the org's later installation", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "mallory" });
    await setAccountScopes(db, a.id, [{ scope: "acme", role: "self" }]); // squatted the org's name before it onboarded
    await upsertInstallation(db, inst()); // acme installs the App
    // mallory is NOT in org_members — the App roster decides alone; the self row must not grant.
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "mallory" }, "acme", 60_000)).toEqual({ status: "none", role: null, via: "app" });
  });

  it("the same squatted self row still grants self when the org has no active installation", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "mallory" });
    await setAccountScopes(db, a.id, [{ scope: "acme", role: "self" }]);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "mallory" }, "acme", 60_000)).toEqual({ status: "ok", role: "self", via: "self" });
  });

  it("a suspended installation behaves as uninstalled: the squatted self row is granted again", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "mallory" });
    await setAccountScopes(db, a.id, [{ scope: "acme", role: "self" }]);
    await upsertInstallation(db, inst());
    await setInstallationSuspended(db, 101, true);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "mallory" }, "acme", 60_000)).toEqual({ status: "ok", role: "self", via: "self" });
  });

  it("a genuine org member with an active installation still gets their App role, unaffected by a squatter's self row", async () => {
    const db = await makeTestDb();
    const alice = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    const mallory = await upsertAccount(db, { provider: "github", accountId: "2", login: "mallory" });
    await setAccountScopes(db, mallory.id, [{ scope: "acme", role: "self" }]);
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "admin" }]);
    expect(await resolveOrgAccess(db, { accountId: alice.id, login: "alice" }, "acme", 60_000)).toEqual({ status: "ok", role: "admin", via: "app" });
  });
});
