// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/__tests__/refusePrivate.controller.test.ts
//
// The anonymous resolve endpoints (gem-archive, game-html, game-meta) must 404 — not 403 — a
// private gem, with the SAME error shape as a missing gem (no existence leak). Public/unlisted
// and archive-only shares (no catalog row at all) are unaffected.
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, upsertGemArchive } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { AggregatorController } from "../../aggregator.controller.js";

function gameGem(name: string, title: string): Gem {
  return {
    name,
    createdFrom: { kind: "blank", title },
    artifacts: [{
      type: "game", name, title, genre: "project-fun",
      html: "<!doctype html><title>t</title><canvas></canvas>",
      createdFrom: { kind: "blank", title }, engineVersion: "1",
    }],
    checks: [], requiredSecrets: [],
  } as unknown as Gem;
}

async function seedGame(db: Awaited<ReturnType<typeof makeTestDb>>, opts: {
  gemKey: string; version: string; name: string; title: string; createdAtMs: number;
  visibility?: "public" | "unlisted" | "private"; catalog?: boolean;
}) {
  const { bytes } = exportGem(gameGem(opts.name, opts.title), { version: opts.version });
  await upsertGemArchive(db, {
    gemKey: opts.gemKey, version: opts.version, bytes, digest: `d-${opts.version}`,
    createdAtMs: opts.createdAtMs,
  });
  if (opts.catalog !== false) {
    await upsertCatalogGem(db, {
      gemKey: opts.gemKey, version: opts.version, publishedBy: "acme", author: "acme",
      tags: [], artifactKinds: ["game"], type: "game",
      artifacts: [{ name: opts.name, type: "game" }], createdAtMs: opts.createdAtMs,
      visibility: opts.visibility ?? "public",
    });
  }
}

describe("anonymous resolve refuses private", () => {
  it("gem-archive 404s a private key", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "@me/g", version: "1", bytes: new Uint8Array([1]), digest: "d", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "1", publishedBy: "me", createdAtMs: 1, visibility: "private" });
    const ctrl = new AggregatorController(db);
    await expect(ctrl.gemArchive({ query: { key: "@me/g", version: "1" } }))
      .rejects.toMatchObject({ statusCode: 404, code: "gem_archive_not_found" });
  });

  it("gem-archive still serves a public key", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "@me/pub", version: "1", bytes: new Uint8Array([1, 2]), digest: "d", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@me/pub", version: "1", publishedBy: "me", createdAtMs: 1, visibility: "public" });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemArchive({ query: { key: "@me/pub", version: "1" } });
    expect(typeof res.archiveBase64).toBe("string");
  });

  it("gem-archive still serves an archive-only key with no catalog row (unlisted share)", async () => {
    const db = await makeTestDb();
    await upsertGemArchive(db, { gemKey: "shareid", version: "1", bytes: new Uint8Array([9]), digest: "d", createdAtMs: 1 });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gemArchive({ query: { key: "shareid", version: "1" } });
    expect(typeof res.archiveBase64).toBe("string");
  });

  it("game-html 404s a private game", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/duel", version: "1.0.0", name: "duel", title: "Duel", createdAtMs: 1, visibility: "private" });
    const ctrl = new AggregatorController(db);
    await expect(ctrl.gameHtml({ query: { key: "@acme/duel", version: "1.0.0" } }))
      .rejects.toMatchObject({ statusCode: 404, code: "gem_archive_not_found" });
  });

  it("game-html still serves a public game", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/duel", version: "1.0.0", name: "duel", title: "Duel", createdAtMs: 1, visibility: "public" });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gameHtml({ query: { key: "@acme/duel", version: "1.0.0" } });
    expect(res.html).toContain("canvas");
  });

  it("game-meta 404s a private game", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/duel", version: "1.0.0", name: "duel", title: "Duel", createdAtMs: 1, visibility: "private" });
    const ctrl = new AggregatorController(db);
    await expect(ctrl.gameMeta({ query: { key: "@acme/duel", version: "1.0.0" } }))
      .rejects.toMatchObject({ statusCode: 404, code: "gem_archive_not_found" });
  });

  it("game-meta still serves a public game", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/duel", version: "1.0.0", name: "duel", title: "Duel", createdAtMs: 1, visibility: "public" });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gameMeta({ query: { key: "@acme/duel", version: "1.0.0" } });
    expect(res.title).toBe("Duel");
  });

  it("game-meta still serves an archive-only game with no catalog row (unlisted share)", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "xK3f9a2Bq1", version: "1", name: "t", title: "Unlisted Game", createdAtMs: 1, catalog: false });
    const ctrl = new AggregatorController(db);
    const res = await ctrl.gameMeta({ query: { key: "xK3f9a2Bq1", version: "1" } });
    expect(res.title).toBe("Unlisted Game");
  });
});
