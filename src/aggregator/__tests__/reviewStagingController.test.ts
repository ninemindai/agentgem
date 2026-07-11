// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, upsertAccount, createNativeGroup, grantInvite, producers, accountBindings, accountScopes, catalogSigningPayload, reviewActionPayload, reviewSubmitPayload, reviewResubmitPayload } from "@agentgem/aggregator";
import { signer, sampleGem, signedPublishBody } from "./helpers/publishFixtures.js";
import { AggregatorController } from "../../aggregator.controller.js";

// Bind a signer's pubkey to a seeded account so resolveSignedAccount maps key -> accounts.id.
async function bind(db: any, pubkey: string, acct: { id: string; login: string }) {
  await db.insert(producers).values({ pubkey }).onConflictDoNothing();
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: acct.login, accountLogin: acct.login });
}
const ownScope = (db: any, accountId: string, scope = "team") => db.insert(accountScopes).values({ accountId, scope, role: "member" });

// A real signed /review/request body: a REAL .gem archive (so importGem succeeds) whose manifest.gemDigest
// matches the bytes (so the D3 digest guard passes). Reuses the publish-path fixture to BUILD the
// archive + manifest, but re-signs with reviewSubmitPayload (S1) — /review/request no longer accepts
// a bare catalogSigningPayload signature (that's /publish-gem's payload).
function submitBody(s: ReturnType<typeof signer>, groupId: string, signedAt: number, description?: string) {
  const b = signedPublishBody(sampleGem(), s, { gemKey: "@team/bot", version: "1.0.0", signedAt });
  const signature = s.sign(reviewSubmitPayload(b.manifest, groupId, b.pubkey, signedAt));
  return { manifest: b.manifest, archiveBase64: b.archiveBase64, groupId, description, pubkey: b.pubkey, signedAt, signature, bytes: b.bytes, gemDigest: b.gemDigest };
}

// A real signed /review/resubmit body, re-signed with reviewResubmitPayload (S1) — distinct from
// both catalogSigningPayload and reviewSubmitPayload, and bound to `requestId` not `groupId`.
function resubmitBody(s: ReturnType<typeof signer>, requestId: string, signedAt: number, description?: string) {
  const b = signedPublishBody(sampleGem(), s, { gemKey: "@team/bot", version: "1.0.1", signedAt });
  const signature = s.sign(reviewResubmitPayload(b.manifest, requestId, b.pubkey, signedAt));
  return { manifest: b.manifest, archiveBase64: b.archiveBase64, requestId, description, pubkey: b.pubkey, signedAt, signature, bytes: b.bytes, gemDigest: b.gemDigest };
}

it("submit -> inbox -> approve over the signed HTTP surface", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  await ownScope(db, author.id);
  const reviewer = await upsertAccount(db, { provider: "github", accountId: "rob", login: "rob" });
  const g = await createNativeGroup(db, author.id, "Team");
  await grantInvite(db, g.id, reviewer.id, "member");
  const aliceKey = signer(); await bind(db, aliceKey.pubkey, { id: author.id, login: "alice" });
  const robKey = signer(); await bind(db, robKey.pubkey, { id: reviewer.id, login: "rob" });
  const c = new AggregatorController(db);

  const now = Date.now();
  const { bytes: _b, gemDigest: _d, ...body } = submitBody(aliceKey, g.id, now, "please");
  const sub = await c.reviewRequest({ body });
  expect(sub.ok).toBe(true);
  const requestId = (sub as { ok: true; requestId: string }).requestId;

  const inboxAt = Date.now();
  const inbox = await c.reviewInbox({ body: { pubkey: robKey.pubkey, signedAt: inboxAt, signature: robKey.sign(reviewActionPayload("inbox", "", robKey.pubkey, inboxAt)) } });
  expect(inbox.requests.map((r: any) => r.id)).toContain(requestId);

  const apAt = Date.now();
  const ap = await c.reviewApprove({ body: { requestId, pubkey: robKey.pubkey, signedAt: apAt, signature: robKey.sign(reviewActionPayload("approve", requestId, robKey.pubkey, apAt)) } });
  expect(ap).toMatchObject({ ok: true, gemKey: "@team/bot", version: "1.0.0" });
});

it("rejects a bad signature with a 4xx AgentError", async () => {
  const db = await makeTestDb();
  const c = new AggregatorController(db);
  const at = Date.now();
  await expect(c.reviewInbox({ body: { pubkey: "ed25519:AAAA", signedAt: at, signature: "bad" } }))
    .rejects.toThrow(); // AgentError, status 401
});

it("self-approval over HTTP is rejected", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  await ownScope(db, author.id);
  const g = await createNativeGroup(db, author.id, "Team");
  const k = signer(); await bind(db, k.pubkey, { id: author.id, login: "alice" });
  const c = new AggregatorController(db);
  const now = Date.now();
  const { bytes: _b, gemDigest: _d, ...body } = submitBody(k, g.id, now);
  const sub = await c.reviewRequest({ body });
  const requestId = (sub as any).requestId;
  const at = Date.now();
  const res = await c.reviewApprove({ body: { requestId, pubkey: k.pubkey, signedAt: at, signature: k.sign(reviewActionPayload("approve", requestId, k.pubkey, at)) } });
  expect(res).toEqual({ ok: false, rejected: "self-approval" });
});

it("rejects a submit whose manifest.gemDigest does not match the archive (D3)", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  await ownScope(db, author.id);
  const g = await createNativeGroup(db, author.id, "Team");
  const k = signer(); await bind(db, k.pubkey, { id: author.id, login: "alice" });
  const c = new AggregatorController(db);
  const now = Date.now();
  const good = submitBody(k, g.id, now);
  const badManifest = { ...good.manifest, gemDigest: "sha256:0000" }; // lie about the digest
  await expect(c.reviewRequest({ body: {
    manifest: badManifest, archiveBase64: good.archiveBase64, groupId: g.id,
    pubkey: k.pubkey, signedAt: now, signature: k.sign(reviewSubmitPayload(badManifest as any, g.id, k.pubkey, now)),
  } })).rejects.toThrow(); // AgentError 400 review_digest_mismatch (signature is valid over badManifest; the digest guard fires)
});

it("a signature bound to one action cannot be replayed for another", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  await ownScope(db, author.id);
  const reviewer = await upsertAccount(db, { provider: "github", accountId: "rob", login: "rob" });
  const g = await createNativeGroup(db, author.id, "Team");
  await grantInvite(db, g.id, reviewer.id, "member");
  const ak = signer(); await bind(db, ak.pubkey, { id: author.id, login: "alice" });
  const rk = signer(); await bind(db, rk.pubkey, { id: reviewer.id, login: "rob" });
  const c = new AggregatorController(db);
  const now = Date.now();
  const { bytes: _b, gemDigest: _d, ...body } = submitBody(ak, g.id, now);
  const sub = await c.reviewRequest({ body });
  const requestId = (sub as any).requestId;
  const at = Date.now();
  // A signature for "withdraw" replayed against the approve route must fail the signature check.
  const stolen = rk.sign(reviewActionPayload("withdraw", requestId, rk.pubkey, at));
  await expect(c.reviewApprove({ body: { requestId, pubkey: rk.pubkey, signedAt: at, signature: stolen } })).rejects.toThrow();
});

// S1 regression: /review/request and /publish-gem/catalog used to verify the SAME payload
// (catalogSigningPayload), so a captured /review/request body could be replayed straight to
// /publish-gem to publish without review. /review/request must now reject a body signed the OLD
// way — a bare catalogSigningPayload signature no longer authorizes it.
it("a body signed with the old catalogSigningPayload (not reviewSubmitPayload) is rejected (401)", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  await ownScope(db, author.id);
  const g = await createNativeGroup(db, author.id, "Team");
  const k = signer(); await bind(db, k.pubkey, { id: author.id, login: "alice" });
  const c = new AggregatorController(db);
  const now = Date.now();
  const good = submitBody(k, g.id, now); // signature already re-signed with reviewSubmitPayload
  const oldSignature = k.sign(catalogSigningPayload(good.manifest, k.pubkey, now)); // the OLD (pre-fix) payload
  await expect(c.reviewRequest({ body: {
    manifest: good.manifest, archiveBase64: good.archiveBase64, groupId: g.id,
    pubkey: k.pubkey, signedAt: now, signature: oldSignature,
  } })).rejects.toThrow(); // AgentError 401 review_unauthorized — a bare catalog signature no longer authorizes a review submit
});

// S1 wiring sanity: /review/resubmit must accept a body signed with reviewResubmitPayload (bound to
// requestId, distinct from both catalogSigningPayload and reviewSubmitPayload) over the real HTTP surface.
it("resubmit over the signed HTTP surface accepts reviewResubmitPayload and rejects the old catalog signature", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  await ownScope(db, author.id);
  const reviewer = await upsertAccount(db, { provider: "github", accountId: "rob", login: "rob" });
  const g = await createNativeGroup(db, author.id, "Team");
  await grantInvite(db, g.id, reviewer.id, "member");
  const k = signer(); await bind(db, k.pubkey, { id: author.id, login: "alice" });
  const rk = signer(); await bind(db, rk.pubkey, { id: reviewer.id, login: "rob" });
  const c = new AggregatorController(db);

  const now = Date.now();
  const { bytes: _b, gemDigest: _d, ...body } = submitBody(k, g.id, now);
  const sub = await c.reviewRequest({ body });
  const requestId = (sub as { ok: true; requestId: string }).requestId;
  const chAt = Date.now();
  const changes = await c.reviewChanges({ body: { requestId, pubkey: rk.pubkey, signedAt: chAt, signature: rk.sign(reviewActionPayload("changes", requestId, rk.pubkey, chAt)) } });
  expect(changes).toEqual({ ok: true });

  const rsAt = Date.now();
  const { bytes: _rb, gemDigest: _rd, ...resub } = resubmitBody(k, requestId, rsAt);
  const rs = await c.reviewResubmit({ body: resub });
  expect(rs).toEqual({ ok: true });

  // Replayed with the old catalogSigningPayload signature (over the SAME manifest/requestId), it must fail.
  const oldSigned = resubmitBody(k, requestId, rsAt + 1);
  const badSignature = k.sign(catalogSigningPayload(oldSigned.manifest, k.pubkey, rsAt + 1));
  await expect(c.reviewResubmit({ body: { ...oldSigned, signature: badSignature } })).rejects.toThrow();
});

// Critical fix: reviewGet called markSeen (a raw upsert) BEFORE getReviewRequest, so a signed but
// nonexistent requestId FK-violated on the review_seen insert -> uncaught 500 instead of a graceful
// { request: null }. This also closed an enumeration oracle: a real foreign-group request and a
// never-existed id must both come back as { request: null } without throwing.
it("reviewGet with a signed but nonexistent requestId returns { request: null } and does not throw", async () => {
  const db = await makeTestDb();
  const someone = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  const k = signer(); await bind(db, k.pubkey, { id: someone.id, login: "alice" });
  const c = new AggregatorController(db);
  const fakeId = randomUUID();
  const at = Date.now();
  const res = await c.reviewGet({ body: { requestId: fakeId, pubkey: k.pubkey, signedAt: at, signature: k.sign(reviewActionPayload("get", fakeId, k.pubkey, at)) } });
  expect(res).toEqual({ request: null });
});
