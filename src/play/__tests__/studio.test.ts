// src/play/__tests__/studio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStudio, studioBrief, studioCwd, miniappsRoot, type SourceReaders } from "@agentgem/play";

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
  it("studioBrief reads meta and instructs editing the sealed html", async () => {
    const { name } = await seedStudio({ kind: "skill", skillName: "brainstorming" }, readers);
    const b = studioBrief(name);
    expect(b).toContain(`${name}.html`);
    expect(b.toLowerCase()).toContain("sealed");
  });
});
