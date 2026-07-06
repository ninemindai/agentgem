// src/gem/__tests__/gameMaterialize.test.ts
import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem, GemArtifact } from "@agentgem/model";

// A game runs in the Play iframe, not on an agent target — so materialize must ignore it: no crash,
// no .claude/ output. This proves adding "game" to the artifact union is repo-safe for target codegen.
const gameGem: Gem = {
  name: "g", createdFrom: "t", checks: [], requiredSecrets: [],
  artifacts: [{
    type: "game", name: "replay", title: "Replay", genre: "replay",
    html: "<!doctype html>", engineVersion: "1",
    createdFrom: { kind: "session", agent: "claude", sessionId: "s", summary: "x" },
  } satisfies GemArtifact],
};

describe("materialize ignores game artifacts", () => {
  it("does not throw and emits no files for a game-only gem", () => {
    const { files } = materialize(gameGem, "claude");
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("still materializes non-game artifacts in a mixed gem, ignoring the game", () => {
    const mixed: Gem = {
      ...gameGem,
      artifacts: [
        ...gameGem.artifacts,
        { type: "instructions", name: "readme", content: "hello" } satisfies GemArtifact,
      ],
    };
    const { files } = materialize(mixed, "claude");
    // the instructions artifact produces output; the game contributes nothing
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(Object.keys(files).some((p) => p.includes("replay") || p.endsWith(".html"))).toBe(false);
  });
});
