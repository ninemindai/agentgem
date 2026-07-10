// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings, type AppDb } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { signer, sampleGem, signedPublishBody } from "./helpers/publishFixtures.js";

// Publish a real game gem so the play endpoint has something to accept a play for.
async function publishGame(db: AppDb, gemKey: string, version = "1.0.0"): Promise<AggregatorController> {
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  const gameGem = { ...sampleGem(), artifacts: [{ type: "game" as const, name: "duel", title: "Duel", genre: "project-fun" as const,
    html: "<!doctype html><body>PLAY ME</body>", createdFrom: { kind: "html" as const, title: "Duel" }, engineVersion: "1" }] };
  const c = new AggregatorController(db);
  await c.publishGem({ body: signedPublishBody(gameGem, s, { gemKey, version, signedAt: Date.now() }) });
  return c;
}

describe("AggregatorController game plays", () => {
  it("records a play and reports it in the counts", async () => {
    const db = await makeTestDb();
    const c = await publishGame(db, "@octocat/duel");
    await c.gamePlay({ body: { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" } });
    const res = await c.gamePlays({ query: { keys: "@octocat/duel" } });
    expect(res.items).toEqual([{ gemKey: "@octocat/duel", plays: 1 }]);
  });

  it("accepts a play with no visitor id", async () => {
    const db = await makeTestDb();
    const c = await publishGame(db, "@octocat/duel");
    await c.gamePlay({ body: { gemKey: "@octocat/duel", version: "1.0.0" } });
    expect((await c.gamePlays({ query: {} })).items).toEqual([{ gemKey: "@octocat/duel", plays: 1 }]);
  });

  it("404s a play for a gem that was never published — the table only holds real games", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    await expect(c.gamePlay({ body: { gemKey: "@octocat/ghost", version: "1.0.0" } })).rejects.toThrow(/not found/i);
    expect((await c.gamePlays({ query: {} })).items).toEqual([]);
  });

  it("reports zero plays as an absent entry, not a row", async () => {
    const db = await makeTestDb();
    const c = await publishGame(db, "@octocat/duel");
    expect((await c.gamePlays({ query: { keys: "@octocat/duel" } })).items).toEqual([]);
  });

  it("fetching the game html does NOT count as a play — the arcade grid renders every card", async () => {
    const db = await makeTestDb();
    const c = await publishGame(db, "@octocat/duel");
    await c.gameHtml({ query: { key: "@octocat/duel", version: "1.0.0" } });
    expect((await c.gamePlays({ query: {} })).items).toEqual([]);
  });
});
