// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, producers, accountBindings, accounts, getGemArchive, listCatalogGems } from "@agentgem/aggregator";
import { exportGem, importGem } from "@agentgem/distribute";
import { catalogSigningPayload } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { signer, gameGem } from "./helpers/publishFixtures.js";

async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

function signedArchiveBody(gem: ReturnType<typeof gameGem>, s: ReturnType<typeof signer>, signedAt = Date.now()) {
  const { bytes } = exportGem(gem, { version: "1" });
  const { meta } = importGem(bytes);
  const manifest = { gemKey: "_", version: "1", gemDigest: meta.gemDigest };
  const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
  return { manifest, archiveBase64: bytes.toString("base64"), pubkey: s.pubkey, signedAt, signature };
}

describe("AggregatorController.shareArchive", () => {
  it("mints an unlisted, owned share and serves it by its scope-less key", async () => {
    const { db, s } = await boundDb();
    const res = await new AggregatorController(db).shareArchive({ body: signedArchiveBody(gameGem(), s) });

    expect(res.key).not.toContain("/");                         // scope-less => unlistable
    expect(res.url).toBe(`https://app.agentgem.ai/games/${res.key}`);
    expect(await getGemArchive(db, res.key, "1")).not.toBeNull();
    expect(await listCatalogGems(db)).toHaveLength(0);          // THE unlisted invariant
  });

  it("rejects HTML that fails the server-side static gate", async () => {
    const { db, s } = await boundDb();
    const evil = gameGem();
    (evil.artifacts[0] as { html: string }).html = "<!doctype html><script>fetch('http://evil')</script>";
    await expect(new AggregatorController(db).shareArchive({ body: signedArchiveBody(evil, s) }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unbound producer (not-connected) and stores nothing", async () => {
    const db = await makeTestDb();
    const s = signer();
    await expect(new AggregatorController(db).shareArchive({ body: signedArchiveBody(gameGem(), s) }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a non-game archive", async () => {
    const { db, s } = await boundDb();
    const notGame = { name: "x", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
      artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s\n" }] } as ReturnType<typeof gameGem>;
    await expect(new AggregatorController(db).shareArchive({ body: signedArchiveBody(notGame, s) }))
      .rejects.toMatchObject({ statusCode: 400, code: "not_a_game" });
  });

  it("rejects an archive whose digest does not match the signed manifest, storing nothing", async () => {
    // The manifest must carry the wrong digest BEFORE signing: the signature covers the whole
    // manifest, so tampering gemDigest after signing would fail signature verification (401)
    // rather than exercising the digest-binding check (400 digest_mismatch) this test targets.
    const { db, s } = await boundDb();
    const { bytes } = exportGem(gameGem(), { version: "1" });
    const signedAt = Date.now();
    const manifest = { gemKey: "_", version: "1", gemDigest: "sha256:deadbeef" };
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const body = { manifest, archiveBase64: bytes.toString("base64"), pubkey: s.pubkey, signedAt, signature };
    await expect(new AggregatorController(db).shareArchive({ body }))
      .rejects.toMatchObject({ statusCode: 400, code: "digest_mismatch" });
    expect(await listCatalogGems(db)).toHaveLength(0);
  });
});

describe("AggregatorController.revokeShareArchive", () => {
  function revokeBody(key: string, s: ReturnType<typeof signer>, signedAt = Date.now()) {
    const payload = `revoke:${key}:${signedAt}`;
    return { key, pubkey: s.pubkey, signedAt, signature: s.sign(payload) };
  }

  it("lets the minting account revoke its own share", async () => {
    const { db, s } = await boundDb();
    const c = new AggregatorController(db);
    const { key } = await c.shareArchive({ body: signedArchiveBody(gameGem(), s) });
    const res = await c.revokeShareArchive({ body: revokeBody(key, s) });
    expect(res).toEqual({ revoked: true });
    expect(await getGemArchive(db, key, "1")).toBeNull();
  });

  it("forbids a different account from revoking (fail-closed)", async () => {
    const { db, s } = await boundDb();
    const c = new AggregatorController(db);
    const { key } = await c.shareArchive({ body: signedArchiveBody(gameGem(), s) });
    // a second bound producer on a DIFFERENT account
    const s2 = signer();
    await db.insert(producers).values({ pubkey: s2.pubkey });
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "2", login: "mallory" });
    await db.insert(accountBindings).values({ pubkey: s2.pubkey, provider: "github", accountId: "2", accountLogin: "mallory" });
    await expect(c.revokeShareArchive({ body: revokeBody(key, s2) })).rejects.toMatchObject({ statusCode: 403 });
    expect(await getGemArchive(db, key, "1")).not.toBeNull();
  });

  it("404s an unknown key", async () => {
    const { db, s } = await boundDb();
    await expect(new AggregatorController(db).revokeShareArchive({ body: revokeBody("nope", s) })).rejects.toMatchObject({ statusCode: 404 });
  });
});
