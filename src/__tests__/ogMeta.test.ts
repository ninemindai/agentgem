// src/__tests__/ogMeta.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, upsertCatalogGem } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { buildOgMeta } from "../og/meta.js";

function gameGem(name: string, title: string): Gem {
  return { name, createdFrom: { kind: "blank", title }, artifacts: [{
    type: "game", name, title, genre: "project-fun",
    html: "<!doctype html><title>t</title><canvas></canvas>",
    createdFrom: { kind: "blank", title }, engineVersion: "1",
  }], checks: [], requiredSecrets: [] } as unknown as Gem;
}

async function seedGame(db: Awaited<ReturnType<typeof makeTestDb>>, key: string, title: string) {
  const { bytes } = exportGem(gameGem("g", title), { version: "1.0.0" });
  await upsertGemArchive(db, { gemKey: key, version: "1.0.0", bytes, digest: "d", createdAtMs: 1 });
  await upsertCatalogGem(db, { gemKey: key, version: "1.0.0", publishedBy: "acme", author: "acme",
    tags: [], artifactKinds: ["game"], type: "game", artifacts: [{ name: "g", type: "game" }], createdAtMs: 1 });
}

describe("buildOgMeta", () => {
  it("game: title + genre subtitle", async () => {
    const db = await makeTestDb();
    await seedGame(db, "@acme/tetris", "Tetris");
    expect(await buildOgMeta(db, { type: "game", key: "@acme/tetris" }))
      .toEqual({ title: "Tetris", description: "Play on AgentGem · project-fun", imageUrl: null });
  });

  it("game: null for an unknown key", async () => {
    const db = await makeTestDb();
    expect(await buildOgMeta(db, { type: "game", key: "@acme/nope" })).toBeNull();
  });

  it("skill: humanized last path segment, sourceId subtitle (no db needed)", async () => {
    const db = await makeTestDb();
    expect(await buildOgMeta(db, { type: "skill", key: "github-xyz/agents/reviewer.md" }))
      .toEqual({ title: "reviewer", description: "Skill · github-xyz on AgentGem", imageUrl: null });
  });
});
