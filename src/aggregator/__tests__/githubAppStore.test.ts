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
  it("self scope is always ok", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "Alice", 1000)).toEqual({ status: "ok", role: "self", via: "self" });
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
});
