import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, upsertCatalogGem, upsertGemCover } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { getCoverDataUri } from "../og/cover.js";

function gameGem(title: string): Gem {
  return { name: "g", createdFrom: { kind: "blank", title }, artifacts: [{
    type: "game", name: "g", title, genre: "project-fun",
    html: "<!doctype html><title>t</title><canvas></canvas>", createdFrom: { kind: "blank", title }, engineVersion: "1",
  }], checks: [], requiredSecrets: [] } as unknown as Gem;
}
async function seed(db: Awaited<ReturnType<typeof makeTestDb>>, key: string, cover?: boolean) {
  const { bytes } = exportGem(gameGem("T"), { version: "1.0.0" });
  await upsertGemArchive(db, { gemKey: key, version: "1.0.0", bytes, digest: "d", createdAtMs: 1 });
  await upsertCatalogGem(db, { gemKey: key, version: "1.0.0", publishedBy: "a", author: "a", tags: [], artifactKinds: ["game"], type: "game", artifacts: [{ name: "g", type: "game" }], createdAtMs: 1 });
  if (cover) await upsertGemCover(db, { gemKey: key, version: "1.0.0", bytes: new Uint8Array([0x89, 0x50, 1]), contentType: "image/png", createdAtMs: 1 });
}

describe("getCoverDataUri", () => {
  it("returns a data URI for a game with a stored cover", async () => {
    const db = await makeTestDb(); await seed(db, "@a/g", true);
    const uri = await getCoverDataUri(db, { type: "game", key: "@a/g" });
    expect(uri?.startsWith("data:image/png;base64,")).toBe(true);
  });
  it("returns null for a game with no cover", async () => {
    const db = await makeTestDb(); await seed(db, "@a/g", false);
    expect(await getCoverDataUri(db, { type: "game", key: "@a/g" })).toBeNull();
  });
  it("returns null for non-game types", async () => {
    const db = await makeTestDb();
    expect(await getCoverDataUri(db, { type: "gem", key: "@a/g" })).toBeNull();
    expect(await getCoverDataUri(db, { type: "skill", key: "s/x.md" })).toBeNull();
  });
});
