// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// End-to-end signing integration test: runs postReviewRequest's REAL ed25519-signed body through a
// REAL AggregatorController(makeTestDb()) via an injected http, proving the local client
// (src/gem/reviewClient.ts) signs EXACTLY what the aggregator verifies (the S1 replay-safety seam).
// Every other test mocks the forward; this one doesn't — a payload drift fails here, not in prod.
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createNativeGroup, grantInvite, producers, accountBindings, accountScopes } from "@agentgem/aggregator";
import { exportGem, importGem } from "@agentgem/distribute";
import { AggregatorController } from "../aggregator.controller.js";
import { signer, sampleGem } from "../aggregator/__tests__/helpers/publishFixtures.js";
import { postReviewRequest, postReviewAction, type ReviewHttp } from "../gem/reviewClient.js";

// Bind a signer's pubkey to a seeded account so the aggregator's resolveSignedAccount maps the
// signature -> accounts.id (identical to reviewStagingController.test.ts's bind helper).
async function bind(db: any, pubkey: string, acct: { login: string }) {
  await db.insert(producers).values({ pubkey }).onConflictDoNothing();
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: acct.login, accountLogin: acct.login });
}

// An http that routes the client's POST into the REAL AggregatorController (no network, no fetch).
function wire(c: AggregatorController): ReviewHttp {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const path = url.split("/api/aggregator")[1];
    const map: Record<string, (b: any) => Promise<any>> = {
      "/review/request": (b) => c.reviewRequest({ body: b }),
      "/review/inbox": (b) => c.reviewInbox({ body: b }),
    };
    const fn = map[path];
    if (!fn) throw new Error("unrouted " + path);
    return { status: 200, json: async () => await fn(body) };
  };
}

describe("review client ↔ real aggregator (e2e signing)", () => {
  it("a locally-signed review request verifies at the aggregator and creates a staging request the reviewer can see", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
    await db.insert(accountScopes).values({ accountId: author.id, scope: "team", role: "member" }); // author owns @team
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "rob", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const ak = signer(); await bind(db, ak.pubkey, { login: "alice" });
    const rk = signer(); await bind(db, rk.pubkey, { login: "rob" });
    const c = new AggregatorController(db);
    const http = wire(c);

    // Build a REAL archive + a manifest whose gemDigest matches (so the aggregator's D3 check passes).
    const { bytes } = exportGem(sampleGem(), { version: "1.0.0" });
    const { meta } = importGem(bytes);
    const manifest = { gemKey: "@team/bot", version: "1.0.0", description: "please review", gemDigest: meta.gemDigest } as any;

    // The author's LOCAL client signs reviewSubmitPayload and forwards to the REAL aggregator.
    const authorIdentity = { publicKey: ak.pubkey, sign: ak.sign };
    const sub = await postReviewRequest({ manifest, archiveBase64: bytes.toString("base64"), groupId: g.id, identity: authorIdentity, http });
    expect(sub).toMatchObject({ ok: true });
    const requestId = (sub as { ok: true; requestId: string }).requestId;

    // The reviewer's LOCAL client signs the inbox action; the real aggregator returns the request.
    const reviewerIdentity = { publicKey: rk.pubkey, sign: rk.sign };
    const inbox = await postReviewAction({ action: "inbox", requestId: "", path: "/review/inbox", identity: reviewerIdentity, http });
    expect(inbox.requests.map((r: any) => r.id)).toContain(requestId);
  });

  it("a review request signed with the WRONG payload (catalogSigningPayload) is rejected by the aggregator", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
    await db.insert(accountScopes).values({ accountId: author.id, scope: "team", role: "member" });
    const g = await createNativeGroup(db, author.id, "Team");
    const ak = signer(); await bind(db, ak.pubkey, { login: "alice" });
    const c = new AggregatorController(db);
    // Forge a body signed with catalogSigningPayload instead of reviewSubmitPayload — must NOT verify.
    const { catalogSigningPayload } = await import("@agentgem/aggregator");
    const { bytes } = exportGem(sampleGem(), { version: "1.0.0" });
    const { meta } = importGem(bytes);
    const manifest = { gemKey: "@team/bot", version: "1.0.0", gemDigest: meta.gemDigest } as any;
    const now = Date.now();
    const badBody = { manifest, archiveBase64: bytes.toString("base64"), groupId: g.id, pubkey: ak.pubkey, signedAt: now, signature: ak.sign(catalogSigningPayload(manifest, ak.pubkey, now)) };
    await expect(c.reviewRequest({ body: badBody })).rejects.toThrow(); // 401: review route rejects a catalog signature
  });
});
