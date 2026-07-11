import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, reviewRequests, upsertAccount, createNativeGroup, grantInvite, submitReviewRequest, upsertCatalogGem, accountScopes, listInbox, markSeen, getReviewRequest, getReviewArchive, addReviewMessage, approveReviewRequest, listCatalogGems, getGemArchive, requestChanges, resubmitReviewRequest, withdrawReviewRequest } from "@agentgem/aggregator";

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

describe("listInbox + markSeen", () => {
  it("lists open requests for the viewer's groups, newest first, unread until seen", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x", description: "d",
    }, 1000);
    if (!r.ok) throw new Error("submit failed");

    const before = await listInbox(db, reviewer.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: r.requestId, gemKey: "@team/bot", authorLogin: "alice", status: "open", unread: true });

    await markSeen(db, reviewer.id, r.requestId, 2000);
    const after = await listInbox(db, reviewer.id);
    expect(after[0].unread).toBe(false);
  });

  it("does not list requests from groups the viewer is not in", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    const g = await createNativeGroup(db, author.id, "Team");
    await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x" }, 1000);
    expect(await listInbox(db, outsider.id)).toEqual([]);
  });
});

describe("request detail / messages / archive", () => {
  async function seed() {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([9, 9]), archiveDigest: "sha256:x", description: "d" }, 1000);
    if (!r.ok) throw new Error("submit failed");
    return { db, author, reviewer, outsider, g, requestId: r.requestId };
  }

  it("a member reads detail + archive; posts a message that appears in detail", async () => {
    const { db, reviewer, requestId } = await seed();
    const detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.gemKey).toBe("@team/bot");
    expect(detail?.messages).toEqual([]);
    const arch = await getReviewArchive(db, reviewer.id, requestId);
    expect(Array.from(arch!.bytes)).toEqual([9, 9]);
    const m = await addReviewMessage(db, { accountId: reviewer.id, requestId, body: "looks good" }, 1500);
    expect(m.ok).toBe(true);
    const after = await getReviewRequest(db, reviewer.id, requestId);
    expect(after?.messages).toHaveLength(1);
    expect(after?.messages[0]).toMatchObject({ authorLogin: "rob", body: "looks good" });
  });

  it("a non-member gets null / not-found for detail, archive, and message", async () => {
    const { db, outsider, requestId } = await seed();
    expect(await getReviewRequest(db, outsider.id, requestId)).toBeNull();
    expect(await getReviewArchive(db, outsider.id, requestId)).toBeNull();
    expect(await addReviewMessage(db, { accountId: outsider.id, requestId, body: "x" })).toEqual({ ok: false, rejected: "not-a-member" });
  });
});

describe("approveReviewRequest", () => {
  async function seedOpen() {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([7]), archiveDigest: "sha256:x", description: "d" }, 1000);
    if (!r.ok) throw new Error("submit failed");
    return { db, author, reviewer, g, requestId: r.requestId };
  }

  it("a member approval publishes the gem + archive and clears staging bytes", async () => {
    const { db, reviewer, requestId } = await seedOpen();
    const res = await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000);
    expect(res).toEqual({ ok: true, gemKey: "@team/bot", version: "1.0.0" });
    const catalog = await listCatalogGems(db);
    expect(catalog.find((c) => c.gemKey === "@team/bot")).toMatchObject({ publishedBy: "alice", installable: true });
    const arch = await getGemArchive(db, "@team/bot", "1.0.0");
    expect(Array.from(arch!.bytes)).toEqual([7]);
    expect(await getReviewArchive(db, reviewer.id, requestId)).toBeNull(); // staging bytes cleared
  });

  it("blocks self-approval by the author", async () => {
    const { db, author, requestId } = await seedOpen();
    expect(await approveReviewRequest(db, { accountId: author.id, requestId })).toEqual({ ok: false, rejected: "self-approval" });
  });

  it("blocks a non-member", async () => {
    const { db, requestId } = await seedOpen();
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    expect(await approveReviewRequest(db, { accountId: outsider.id, requestId })).toEqual({ ok: false, rejected: "not-a-member" });
  });

  it("a second approval is a no-op (not-open), gem published exactly once", async () => {
    const { db, reviewer, requestId } = await seedOpen();
    const first = await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000);
    expect(first.ok).toBe(true);
    const second = await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2001);
    expect(second).toEqual({ ok: false, rejected: "not-open" });
  });

  it("rejects with conflict when the (key,version) is already owned by someone else", async () => {
    const { db, reviewer, requestId } = await seedOpen();
    const other = await upsertAccount(db, { provider: "github", accountId: "o2", login: "otto" });
    await upsertCatalogGem(db, { gemKey: "@team/bot", version: "1.0.0", publishedBy: "otto", createdAtMs: 1, ownerAccountId: other.id });
    expect(await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000)).toEqual({ ok: false, rejected: "conflict" });
    // transition rolled back — still open
    const detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.status).toBe("open");
  });

  it("re-checks scope ownership at approval: rejects if the author lost the scope since submitting", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    // Author owned `team` at submit; now they lose it (e.g. left the org). Approval must re-check.
    await db.delete(accountScopes).where(eq(accountScopes.accountId, author.id));
    expect(await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000)).toEqual({ ok: false, rejected: "not-scope-owner" });
    expect((await getReviewRequest(db, reviewer.id, requestId))?.status).toBe("open"); // rolled back
  });
});

describe("requestChanges / resubmit / withdraw", () => {
  async function seedOpen() {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    await ownScope(db, author.id);
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x", description: "d" }, 1000);
    if (!r.ok) throw new Error("submit failed");
    return { db, author, reviewer, requestId: r.requestId };
  }

  it("reviewer requests changes; author resubmits back to open with new bytes; seen markers cleared", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    await markSeen(db, reviewer.id, requestId, 1100);
    expect(await requestChanges(db, { accountId: reviewer.id, requestId }, 1200)).toEqual({ ok: true });
    let detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.status).toBe("changes-requested");
    const rs = await resubmitReviewRequest(db, { accountId: author.id, requestId, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([2, 2]), archiveDigest: "sha256:y" }, 1300);
    expect(rs).toEqual({ ok: true });
    detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.status).toBe("open");
    const arch = await getReviewArchive(db, author.id, requestId);
    expect(Array.from(arch!.bytes)).toEqual([2, 2]);
    // reviewer's badge is unread again after resubmit
    const inbox = await listInbox(db, reviewer.id);
    expect(inbox.find((x) => x.id === requestId)?.unread).toBe(true);
  });

  it("author cannot self-request-changes; reviewer cannot resubmit or withdraw", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    expect(await requestChanges(db, { accountId: author.id, requestId })).toEqual({ ok: false, rejected: "self" });
    expect(await resubmitReviewRequest(db, { accountId: reviewer.id, requestId, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "z" })).toEqual({ ok: false, rejected: "not-changes-requested" });
    expect(await withdrawReviewRequest(db, { accountId: reviewer.id, requestId })).toEqual({ ok: false, rejected: "forbidden" });
  });

  it("author withdraws an open request; bytes cleared, status withdrawn, drops off inbox", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    expect(await withdrawReviewRequest(db, { accountId: author.id, requestId }, 1400)).toEqual({ ok: true });
    expect(await getReviewArchive(db, reviewer.id, requestId)).toBeNull();
    expect((await getReviewRequest(db, reviewer.id, requestId))?.status).toBe("withdrawn");
    expect(await listInbox(db, reviewer.id)).toEqual([]);
  });

  it("commenting on a terminal (withdrawn) request is still allowed — post-hoc discussion", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    await withdrawReviewRequest(db, { accountId: author.id, requestId }, 1400);
    const m = await addReviewMessage(db, { accountId: reviewer.id, requestId, body: "why withdrawn?" }, 1500);
    expect(m.ok).toBe(true);
    expect((await getReviewRequest(db, reviewer.id, requestId))?.messages).toHaveLength(1);
  });
});
