// src/play/__tests__/sourceContext.mismatch.test.ts
import { describe, it, expect } from "vitest";
import { extractSource, type SourceReaders } from "@agentgem/play";
import type { GameSource } from "@agentgem/model";

const readers: SourceReaders = {
  loadSession: async () => ({ sessionId: "s1", meta: {}, turns: [] }),
  readSkill: async () => ({ name: "k", content: "c" }),
  readProject: async () => ({ path: "/p", flavor: "node", files: ["a.ts"] }),
};

const session: GameSource = { kind: "session", agent: "claude", sessionId: "s1", summary: "x" };

describe("extractSource genre/source agreement", () => {
  it("rejects a genre whose sourceKind does not match the source", async () => {
    await expect(extractSource(session, readers, "skill-run")).rejects.toThrow(/does not accept a session source/);
  });

  it("accepts a genre that matches the source kind", async () => {
    const out = await extractSource(session, readers, "session-heatmap");
    expect(out.genre).toBe("session-heatmap");
  });

  it("still defaults when no genre is requested", async () => {
    const out = await extractSource(session, readers, undefined);
    expect(out.genre).toBe("replay");
  });
});
