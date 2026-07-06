// src/play/__tests__/sourceContext.test.ts
import { describe, it, expect } from "vitest";
import { extractSource, type SourceReaders } from "@agentgem/play";
import type { GameSource } from "@agentgem/model";

const readers: SourceReaders = {
  loadSession: async (id) => ({ sessionId: id, meta: { msgs: 2 }, turns: [{ role: "assistant", text: "patched login" }] }),
  readSkill: async (name) => ({ name, content: "# " + name, trigger: { intent: "x", triggers: ["a"], antiTriggers: [] } }),
  readProject: async (path) => ({ path, flavor: "node", files: ["package.json"] }),
};

describe("extractSource", () => {
  it("session → replay", async () => {
    const src: GameSource = { kind: "session", agent: "claude", sessionId: "s1", summary: "auth" };
    const input = await extractSource(src, readers);
    expect(input.genre).toBe("replay");
    expect(input.createdFrom).toEqual(src);
    expect(JSON.stringify(input.data)).toContain("patched login");
  });
  it("skill → skill-run", async () => {
    const input = await extractSource({ kind: "skill", skillName: "brainstorming" }, readers);
    expect(input.genre).toBe("skill-run");
    expect(JSON.stringify(input.data)).toContain("brainstorming");
  });
  it("project → project-fun", async () => {
    const input = await extractSource({ kind: "project", path: "/p", flavor: "node" }, readers);
    expect(input.genre).toBe("project-fun");
    expect(JSON.stringify(input.data)).toContain("package.json");
  });
  it("throws when the session is missing", async () => {
    await expect(extractSource({ kind: "session", agent: "claude", sessionId: "gone", summary: "x" }, { ...readers, loadSession: async () => null })).rejects.toThrow(/session/);
  });
});
