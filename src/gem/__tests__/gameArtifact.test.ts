// src/gem/__tests__/gameArtifact.test.ts
import { describe, it, expect } from "vitest";
import type { GameArtifact, GemArtifact } from "@agentgem/model";

describe("GameArtifact", () => {
  it("is assignable to GemArtifact and narrows on type:'game'", () => {
    const g: GameArtifact = {
      type: "game",
      name: "auth-bugfix-replay",
      title: "The Great Auth Bug Hunt",
      genre: "replay",
      html: "<!doctype html><body><canvas></canvas></body>",
      createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "fixed auth bug" },
      engineVersion: "1",
    };
    const a: GemArtifact = g; // must compile
    expect(a.type).toBe("game");
    if (a.type === "game") expect(a.genre).toBe("replay"); // narrows
  });

  it("accepts a declared read-only capability and each source kind", () => {
    const withNeeds: GameArtifact = {
      type: "game", name: "n", title: "T", genre: "skill-run",
      html: "<!doctype html>", engineVersion: "1",
      needs: ["live-session-events"],
      createdFrom: { kind: "skill", skillName: "brainstorming" },
      meta: { controls: "arrow keys", estPlaySeconds: 120 },
    };
    const project: GameArtifact["createdFrom"] = { kind: "project", path: "/x", flavor: "node" };
    expect(withNeeds.needs).toEqual(["live-session-events"]);
    expect(project.kind).toBe("project");
  });
});
