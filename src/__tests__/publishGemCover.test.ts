// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Reuses the EXACT signed-body + bound-producer pattern from
// src/aggregator/__tests__/publishGem.controller.test.ts (do not invent signing).
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings, accounts, getGemCover } from "@agentgem/aggregator";
import { AggregatorController } from "../aggregator.controller.js";
import { signer, gameGem, signedPublishBody } from "../aggregator/__tests__/helpers/publishFixtures.js";

// Copied verbatim from publishGem.controller.test.ts:8-17 — binds the signer's pubkey to a seeded
// account so recordCatalogShare resolves an owner (else the publish is rejected "not-connected").
async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accounts).values({ id: crypto.randomUUID(), provider: "github", providerAccountId: "1", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

function bodyWithCover(s: ReturnType<typeof signer>, coverDataUrl?: string) {
  const base = signedPublishBody(gameGem(), s, { gemKey: "@octocat/tetris", version: "1.0.0", signedAt: Date.now() });
  return { ...base, ...(coverDataUrl ? { coverDataUrl } : {}) };
}

describe("publishGem cover", () => {
  it("stores a valid cover after the archive", async () => {
    const { db, s } = await boundDb();
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString("base64")}`;
    const res = await new AggregatorController(db).publishGem({ body: bodyWithCover(s, png) as never });
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat" });
    const cover = await getGemCover(db, "@octocat/tetris", "1.0.0");
    expect(cover?.contentType).toBe("image/png");
  });

  it("ignores an invalid cover WITHOUT failing the publish", async () => {
    const { db, s } = await boundDb();
    const res = await new AggregatorController(db).publishGem({ body: bodyWithCover(s, "data:text/html;base64,AAAA") as never });
    expect(res).toMatchObject({ shared: true });      // publish still succeeds
    expect(await getGemCover(db, "@octocat/tetris", "1.0.0")).toBeNull();
  });

  it("publishes fine with no cover", async () => {
    const { db, s } = await boundDb();
    const res = await new AggregatorController(db).publishGem({ body: bodyWithCover(s, undefined) as never });
    expect(res).toMatchObject({ shared: true });
  });
});
