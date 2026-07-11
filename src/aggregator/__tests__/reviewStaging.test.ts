import { describe, it, expect } from "vitest";
import { makeTestDb, reviewRequests, upsertAccount, createNativeGroup, grantInvite, submitReviewRequest, upsertCatalogGem, accountScopes } from "@agentgem/aggregator";

describe("review staging schema", () => {
  it("ensureSchema creates review_requests and the table accepts a row", async () => {
    const db = await makeTestDb(); // makeTestDb runs ensureSchema
    const rows = await db.select().from(reviewRequests);
    expect(rows).toEqual([]);
  });
});

const mkManifest = (gemKey: string, version = "1.0.0") => ({ gemKey, version, description: "d", gemDigest: "sha256:deadbeef" });

// Grant an account ownership of a publish scope (the org-membership half of accountOwnsScope). Every
// seed that will submit `@team/bot` must first grant the AUTHOR the `team` scope, or the new
// scope-ownership guard rejects the submit with `not-scope-owner`. Reused across all describes below.
const ownScope = (db: any, accountId: string, scope = "team") =>
  db.insert(accountScopes).values({ accountId, scope, role: "member" });

describe("submitReviewRequest", () => {
  it("a group member who owns the scope can submit a staging request", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const g = await createNativeGroup(db, author.id, "Team");
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"),
      archiveBytes: new Uint8Array([1, 2, 3]), archiveDigest: "sha256:deadbeef", description: "please review",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a member who does NOT own the gem's scope", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const g = await createNativeGroup(db, author.id, "Team"); // author owns no scope
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@microsoft/tool"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "not-scope-owner" });
  });

  it("rejects a non-member", async () => {
    const db = await makeTestDb();
    const owner = await upsertAccount(db, { provider: "github", accountId: "o", login: "owner" });
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    await ownScope(db, outsider.id); // owns the scope, but is not in the group — membership fails first
    const g = await createNativeGroup(db, owner.id, "Team");
    const r = await submitReviewRequest(db, {
      accountId: outsider.id, groupId: g.id, manifest: mkManifest("@team/bot"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "not-a-member" });
  });

  it("rejects a version that is already published", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const g = await createNativeGroup(db, author.id, "Team");
    await upsertCatalogGem(db, { gemKey: "@team/bot", version: "1.0.0", publishedBy: "alice", createdAtMs: 1, ownerAccountId: author.id });
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot", "1.0.0"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "version-published" });
  });

  it("rejects a slash-less (unlisted-share) key", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const g = await createNativeGroup(db, author.id, "Team");
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("abc123", "1.0.0"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "invalid-key" });
  });
});
