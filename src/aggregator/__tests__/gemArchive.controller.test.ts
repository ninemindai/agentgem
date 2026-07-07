// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { signer, sampleGem, signedPublishBody } from "./helpers/publishFixtures.js";

describe("AggregatorController.gemArchive", () => {
  it("returns the stored archive bytes for a published gem", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const body = signedPublishBody(sampleGem(), s, { gemKey: "@octocat/setup", version: "1.0.0", signedAt: Date.now() });
    const c = new AggregatorController(db);
    await c.publishGem({ body });
    const res = await c.gemArchive({ query: { key: "@octocat/setup", version: "1.0.0" } });
    expect(Buffer.from(res.archiveBase64, "base64").equals(body.bytes)).toBe(true);
  });
  it("404s an unknown gem", async () => {
    const db = await makeTestDb();
    await expect(new AggregatorController(db).gemArchive({ query: { key: "@x/none", version: "1.0.0" } })).rejects.toThrow(/not found/i);
  });

  it("game-html returns the game artifact's sealed html (for the marketplace to play)", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const gameGem = { ...sampleGem(), artifacts: [{ type: "game" as const, name: "duel", title: "Duel", genre: "project-fun" as const,
      html: "<!doctype html><body><h1>PLAY ME</h1></body>", createdFrom: { kind: "html" as const, title: "Duel" }, engineVersion: "1" }] };
    const body = signedPublishBody(gameGem, s, { gemKey: "@octocat/duel", version: "1.0.0", signedAt: Date.now() });
    const c = new AggregatorController(db);
    await c.publishGem({ body });
    const res = await c.gameHtml({ query: { key: "@octocat/duel", version: "1.0.0" } });
    expect(res.html).toContain("PLAY ME");
  });

  it("game-html 404s a gem that has no game artifact", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const body = signedPublishBody(sampleGem(), s, { gemKey: "@octocat/setup", version: "1.0.0", signedAt: Date.now() });
    const c = new AggregatorController(db);
    await c.publishGem({ body });
    await expect(c.gameHtml({ query: { key: "@octocat/setup", version: "1.0.0" } })).rejects.toThrow(/no game/i);
  });
});
