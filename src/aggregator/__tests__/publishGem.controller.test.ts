// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings, getGemArchive, listCatalogGems } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { signer, sampleGem, signedPublishBody } from "./helpers/publishFixtures.js";

async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

describe("AggregatorController.publishGem", () => {
  it("stores the archive and marks the gem installable for a bound producer", async () => {
    const { db, s } = await boundDb();
    const body = signedPublishBody(sampleGem(), s, { gemKey: "@octocat/setup", version: "1.0.0", signedAt: Date.now() });
    const res = await new AggregatorController(db).publishGem({ body });
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat" });
    expect(await getGemArchive(db, "@octocat/setup", "1.0.0")).not.toBeNull();
    const row = (await listCatalogGems(db))[0];
    expect(row.installable).toBe(true);
    expect(row.artifacts).toEqual([
      { name: "brainstorm", type: "skill" }, { name: "guide", type: "instructions" },
      { name: "gh", type: "mcp_server" }, { name: "fmt", type: "hook" },
    ]);
  });

  it("rejects an archive whose digest does not match the signed manifest", async () => {
    const { db, s } = await boundDb();
    const body = signedPublishBody(sampleGem(), s, { gemKey: "@octocat/setup", version: "1.0.0", signedAt: Date.now() });
    const tampered = { ...body, manifest: { ...body.manifest, gemDigest: "sha256:deadbeef" } };
    const res = await new AggregatorController(db).publishGem({ body: tampered });
    expect(res.shared).toBe(false);
    expect(await getGemArchive(db, "@octocat/setup", "1.0.0")).toBeNull();
  });

  it("rejects an unbound producer (not-connected)", async () => {
    const db = await makeTestDb();
    const s = signer();
    const body = signedPublishBody(sampleGem(), s, { gemKey: "@octocat/setup", version: "1.0.0", signedAt: Date.now() });
    const res = await new AggregatorController(db).publishGem({ body });
    expect(res).toMatchObject({ shared: false, rejected: "not-connected" });
  });
});
