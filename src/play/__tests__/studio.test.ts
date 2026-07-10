// src/play/__tests__/studio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStudio, blankStudio, saveMiniapp, studioBrief, studioCwd, miniappsRoot, type SourceReaders } from "@agentgem/play";

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
    expect(brief).toContain(`${name}.html`);                       // the per-miniapp line survives
    expect(brief).toContain("ui/notifications/tool-result");       // the full contract is inlined
    expect(brief).toContain("agentgem_invoke_agent");
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

  // "New miniapp" is always a NEW miniapp. Creating from a source you've already used must never
  // silently clobber the earlier one — reuse of an id happens only on the open-for-editing path.
  it("seedStudio twice from the SAME session mints a second miniapp and leaves the first intact", async () => {
    const source = { kind: "session" as const, agent: "claude", sessionId: "s1", summary: "auth" };
    const first = await seedStudio(source, readers);
    // mark the first so an overwrite would be detectable
    const firstHtml = join(miniappsRoot(), first.name, `${first.name}.html`);
    writeFileSync(firstHtml, `${readFileSync(firstHtml, "utf8")}<!--ORIGINAL-->`);

    const second = await seedStudio(source, readers);
    expect(second.name).not.toBe(first.name);
    expect(second.name).toBe(`${first.name}-2`);
    expect(readFileSync(firstHtml, "utf8")).toContain("<!--ORIGINAL-->"); // untouched
    expect(existsSync(join(miniappsRoot(), second.name, `${second.name}.html`))).toBe(true);
  });

  it("two different projects sharing a folder basename get distinct miniapps", async () => {
    const a = await seedStudio({ kind: "project", path: "/one/api", flavor: "node" }, readers);
    const b = await seedStudio({ kind: "project", path: "/two/api", flavor: "node" }, readers);
    expect(a.name).toBe("api");
    expect(b.name).toBe("api-2");
  });

  it("blankStudio suffixes a repeated title rather than overwriting", async () => {
    expect((await blankStudio("Untitled")).name).toBe("untitled");
    expect((await blankStudio("Untitled")).name).toBe("untitled-2");
    expect((await blankStudio("Untitled")).name).toBe("untitled-3");
  });

  // The other half of the contract: editing an EXISTING miniapp reuses its id (no new entry per save).
  it("saving an existing miniapp reuses its id instead of minting a new one", async () => {
    const { name } = await blankStudio("Reuse Me");
    await saveMiniapp({ name, html: "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>", meta: {
      title: "Reuse Me", genre: "project-fun", createdFrom: { kind: "blank", title: "Reuse Me" }, engineVersion: "1",
    } });
    expect(existsSync(join(miniappsRoot(), `${name}-2`))).toBe(false);
    expect(readFileSync(join(miniappsRoot(), name, `${name}.html`), "utf8")).toContain("canvas");
  });
});
