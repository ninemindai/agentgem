// src/__tests__/gameMeta.controller.test.ts
//
// AggregatorController.gameMeta — GET /api/aggregator/game-meta. The Play page addresses a game by
// bare key (/games/@acme/tetris), so this route owns latest-version resolution. It must also serve a
// scope-less (unlisted) key, which PR 2's share-archive path mints.
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, upsertGemArchive } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { AggregatorController } from "../aggregator.controller.js";

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
  gemKey: string; version: string; name: string; title: string; createdAtMs: number; catalog?: boolean;
}) {
  const { bytes } = exportGem(gameGem(opts.name, opts.title), { version: opts.version });
  await upsertGemArchive(db, {
    gemKey: opts.gemKey, version: opts.version, bytes, digest: `d-${opts.version}`, createdAtMs: opts.createdAtMs,
  });
  if (opts.catalog !== false) {
    // CatalogRow's optional fields are `?: T`, not `T | null` — omit them rather than passing null.
    await upsertCatalogGem(db, {
      gemKey: opts.gemKey, version: opts.version, publishedBy: "acme", author: "acme",
      tags: [], artifactKinds: ["game"], type: "game",
      artifacts: [{ name: opts.name, type: "game" }], createdAtMs: opts.createdAtMs,
    });
  }
}

describe("AggregatorController.gameMeta", () => {
  it("resolves a bare key to its most recently published version", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/tetris", version: "1.0.0", name: "tetris", title: "Old Tetris", createdAtMs: 1000 });
    await seedGame(db, { gemKey: "@acme/tetris", version: "2.0.0", name: "tetris", title: "New Tetris", createdAtMs: 2000 });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "@acme/tetris" } });

    expect(res).toEqual({ title: "New Tetris", genre: "project-fun", version: "2.0.0" });
  });

  it("honors an explicit version", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "@acme/tetris", version: "1.0.0", name: "tetris", title: "Old Tetris", createdAtMs: 1000 });
    await seedGame(db, { gemKey: "@acme/tetris", version: "2.0.0", name: "tetris", title: "New Tetris", createdAtMs: 2000 });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "@acme/tetris", version: "1.0.0" } });

    expect(res.title).toBe("Old Tetris");
    expect(res.version).toBe("1.0.0");
  });

  it("serves a scope-less unlisted key by falling back to the archive's own version", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "xK3f9a2Bq1", version: "1", name: "tetris", title: "Unlisted", createdAtMs: 1000, catalog: false });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "xK3f9a2Bq1", version: "1" } });

    expect(res).toEqual({ title: "Unlisted", genre: "project-fun", version: "1" });
  });

  it("404s an unknown key", async () => {
    const db = await makeTestDb();
    await expect(new AggregatorController(db).gameMeta({ query: { key: "@acme/nope" } }))
      .rejects.toMatchObject({ statusCode: 404, code: "gem_archive_not_found" });
  });

  it("404s a gem that has no game artifact", async () => {
    const db = await makeTestDb();
    const plain = { name: "search", createdFrom: { kind: "blank", title: "s" },
      artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\n" }],
      checks: [], requiredSecrets: [] } as unknown as Gem;
    const { bytes } = exportGem(plain, { version: "1.0.0" });
    await upsertGemArchive(db, { gemKey: "@acme/search", version: "1.0.0", bytes, digest: "d", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@acme/search", version: "1.0.0", publishedBy: "acme", author: "acme",
      tags: [], artifactKinds: ["skill"], type: "skill",
      artifacts: [{ name: "search", type: "skill" }], createdAtMs: 1 });

    await expect(new AggregatorController(db).gameMeta({ query: { key: "@acme/search" } }))
      .rejects.toMatchObject({ statusCode: 404, code: "not_a_game" });
  });

  it("resolves an unlisted share key (no catalog row) via its archive", async () => {
    const db = await makeTestDb();
    await seedGame(db, { gemKey: "xK3f9a2Bq1", version: "1", name: "t", title: "Unlisted Game", createdAtMs: 1, catalog: false });

    const res = await new AggregatorController(db).gameMeta({ query: { key: "xK3f9a2Bq1" } });
    expect(res).toEqual({ title: "Unlisted Game", genre: "project-fun", version: "1" });
  });
});
