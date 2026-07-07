// src/play/__tests__/studio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStudio, blankStudio, studioBrief, studioCwd, miniappsRoot, type SourceReaders } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const readers: SourceReaders = {
  loadSession: async (id) => ({ sessionId: id, meta: { msgs: 1 }, turns: [{ role: "assistant", text: "patched login" }] }),
  readSkill: async (name) => ({ name, content: "# " + name, trigger: undefined }),
  readProject: async (path) => ({ path, flavor: "node", files: ["package.json"] }),
};

describe("studio", () => {
  it("studioCwd allows a miniapp dir and falls back for anything else", () => {
    const fallback = join(home, ".agentgem", "chat");
    const mini = join(miniappsRoot(), "g");
    expect(studioCwd(mini, fallback)).toBe(mini);
    expect(studioCwd("/etc", fallback)).toBe(fallback);
    expect(studioCwd(undefined, fallback)).toBe(fallback);
    // a path that only textually starts with the root but escapes it must NOT be honored
    expect(studioCwd(join(miniappsRoot(), "..", "..", "etc"), fallback)).toBe(fallback);
  });
  it("seedStudio creates + seeds a miniapp dir (scaffold + injected data + meta + commit)", async () => {
    const { name, brief } = await seedStudio({ kind: "project", path: "/p/my-proj", flavor: "node" }, readers);
    const dir = join(miniappsRoot(), name);
    const html = readFileSync(join(dir, `${name}.html`), "utf8");
    expect(html).toContain("AGENTGEM:GAME-LOGIC");   // scaffold present
    expect(html).toContain("game-data");             // DATA injected
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(miniappsRoot(), ".git"))).toBe(true); // committed to the registry repo
    expect(brief).toContain(name);
  });
  it("seedStudio for a session (replay) bakes a redacted snapshot AND keeps the session-data need for local upgrade", async () => {
    const secretReaders: SourceReaders = {
      ...readers,
      loadSession: async (id) => ({ sessionId: id, meta: { msgs: 1 }, turns: [{ role: "assistant", text: "used ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 to push" }] }),
    };
    const { name } = await seedStudio({ kind: "session", agent: "claude", sessionId: "s1", summary: "auth" }, secretReaders);
    const dir = join(miniappsRoot(), name);
    const html = readFileSync(join(dir, `${name}.html`), "utf8");
    expect(html).toContain('id="game-data" type="application/json"'); // now baked → runs with no host
    expect(html).toContain("‹redacted›");                             // the token was scrubbed
    expect(html).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.needs).toEqual(["session-data"]);                    // still declared for the local upgrade path
  });
  it("blankStudio creates a from-scratch miniapp: blank sealed scaffold, NO baked data, blank provenance", async () => {
    const { name, brief } = await blankStudio("Space Dodger", "a dodge-the-asteroids game");
    expect(name).toBe("space-dodger");
    const dir = join(miniappsRoot(), name);
    const html = readFileSync(join(dir, `${name}.html`), "utf8");
    expect(html).toContain("AGENTGEM:GAME-LOGIC");                    // sealed scaffold present
    expect(html).not.toContain('id="game-data" type="application/json"'); // no source data baked in
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.genre).toBe("project-fun");
    expect(meta.createdFrom).toEqual({ kind: "blank", title: "Space Dodger" });
    expect(brief).toContain("from scratch");
    expect(brief).toContain("a dodge-the-asteroids game");            // prompt threaded into the brief
  });
  it("blankStudio without a prompt asks the agent what to build", async () => {
    const { brief } = await blankStudio("Untitled");
    expect(brief.toLowerCase()).toContain("ask the user");
  });

  it("studioBrief reads meta and instructs editing the sealed html", async () => {
    const { name } = await seedStudio({ kind: "skill", skillName: "brainstorming" }, readers);
    const b = studioBrief(name);
    expect(b).toContain(`${name}.html`);
    expect(b.toLowerCase()).toContain("sealed");
  });
});
