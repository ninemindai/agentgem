// src/play/__tests__/sourceContext.test.ts
import { describe, it, expect } from "vitest";
import { extractSource, compactTurns, type SourceReaders } from "@agentgem/play";
import type { GameSource } from "@agentgem/model";

const readers: SourceReaders = {
  loadSession: async (id) => ({ sessionId: id, meta: { msgs: 2 }, turns: [{ role: "assistant", text: "patched login" }] }),
  readSkill: async (name) => ({ name, content: "# " + name, trigger: { intent: "x", triggers: ["a"], antiTriggers: [] } }),
  readProject: async (path) => ({ path, flavor: "node", files: ["package.json"] }),
};

describe("extractSource", () => {
  it("session → replay (compact {meta, timeline})", async () => {
    const src: GameSource = { kind: "session", agent: "claude", sessionId: "s1", summary: "auth" };
    const input = await extractSource(src, readers);
    expect(input.genre).toBe("replay");
    expect(input.createdFrom).toEqual(src);
    const data = input.data as { meta: unknown; timeline: { text: string }[] };
    expect(data.timeline[0].text).toContain("patched login");
  });

  it("compactTurns trims spans/text to a short timeline entry", () => {
    const out = compactTurns([
      { role: "user", tsMs: 1, spans: [{ kind: "message", text: "  fix   auth  " }] },
      { role: "assistant", tsMs: 2, text: "x".repeat(500) },
      "junk",
    ]);
    expect(out[0]).toEqual({ role: "user", tsMs: 1, text: "fix auth" }); // whitespace-collapsed
    expect(out[1].text.length).toBe(200);                                // capped
    expect(out[2]).toEqual({ role: "assistant", tsMs: 0, text: "" });    // defensive on junk
  });
  it("session + genre 'session-heatmap' forks to the heatmap genre (same data shape)", async () => {
    const src: GameSource = { kind: "session", agent: "claude", sessionId: "s1", summary: "auth" };
    const input = await extractSource(src, readers, "session-heatmap");
    expect(input.genre).toBe("session-heatmap");
    expect(input.createdFrom).toEqual(src);
    const data = input.data as { meta: unknown; timeline: { text: string }[] };
    expect(data.timeline[0].text).toContain("patched login");
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
  it("rejects html and blank (created directly, never seeded through extractSource)", async () => {
    await expect(extractSource({ kind: "html", title: "x" }, readers)).rejects.toThrow(/imported directly/);
    await expect(extractSource({ kind: "blank", title: "x" }, readers)).rejects.toThrow(/created directly/);
  });
  it("throws when the session is missing", async () => {
    await expect(extractSource({ kind: "session", agent: "claude", sessionId: "gone", summary: "x" }, { ...readers, loadSession: async () => null })).rejects.toThrow(/session/);
  });
});
