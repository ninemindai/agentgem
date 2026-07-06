// src/gem/__tests__/gameArchive.test.ts
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem, GameArtifact } from "@agentgem/model";

const game: GameArtifact = {
  type: "game",
  name: "auth-replay",
  title: "The Great Auth Bug Hunt",
  genre: "replay",
  html: "<!doctype html><body><canvas></canvas></body>",
  poster: "data:image/png;base64,AAAA",
  needs: ["live-session-events"],
  meta: { controls: "arrow keys", estPlaySeconds: 120 },
  createdFrom: { kind: "session", agent: "claude", project: "app", sessionId: "s1", summary: "fixed auth" },
  engineVersion: "1",
};
const gem: Gem = { name: "g", createdFrom: "t", artifacts: [game], checks: [], requiredSecrets: [] };

describe("game archive round-trip", () => {
  it("preserves the GameArtifact shape through write -> read", () => {
    const { files } = writeGemArchive(gem);
    const back = readGemArchive(files);
    expect(back.artifacts).toHaveLength(1);
    expect(back.artifacts[0]).toEqual(game); // all fields incl. poster/needs/meta/createdFrom survive
  });

  it("rejects a tampered game archive via lock integrity", () => {
    // Games are shareable, so the archive must be integrity-protected: tampering with the
    // manifest (here, stripping the game entry's createdFrom) is caught by gem.lock verification.
    const { files } = writeGemArchive(gem);
    const mutated: Record<string, string> = { ...files };
    const manifest = JSON.parse(files["gem.json"]) as { artifacts: Array<{ type: string; metadata?: string }> };
    for (const a of manifest.artifacts) {
      if (a.type === "game" && typeof a.metadata === "string") {
        const md = JSON.parse(a.metadata) as Record<string, unknown>;
        delete md.createdFrom;
        a.metadata = JSON.stringify(md);
      }
    }
    mutated["gem.json"] = JSON.stringify(manifest);
    expect(() => readGemArchive(mutated)).toThrow(/verification failed/);
  });
});
