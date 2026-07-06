// src/play/__tests__/miniapps.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, listMiniapps, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };
const sealed = "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>";

describe("miniapps store", () => {
  it("miniappDir is jailed under ~/.agentgem/miniapps and rejects traversal", () => {
    expect(miniappDir("g")).toContain(join(home, "miniapps", "g")); // jailed under AGENTGEM_HOME/miniapps
    expect(() => miniappDir("../escape")).toThrow();
    expect(() => miniappDir("a/b")).toThrow();
  });
  it("saveMiniapp gates, dual-writes (git file + gem), and lists", async () => {
    const res = await saveMiniapp({ name: "my-game", html: sealed, meta });
    expect(res.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(readFileSync(join(miniappDir("my-game"), "my-game.html"), "utf8")).toContain("canvas");
    expect(existsSync(join(miniappDir("my-game"), "meta.json"))).toBe(true);
    expect(existsSync(join(workspaceDir("my-game"), "gem.json"))).toBe(true);
    expect(listMiniapps().map((m) => m.name)).toContain("my-game");
  });
  it("re-save keeps the dual-written gem in sync with the latest html (upsert, no drift)", async () => {
    await saveMiniapp({ name: "up", html: sealed.replace("canvas", "canvas data-v1"), meta });
    await saveMiniapp({ name: "up", html: sealed.replace("canvas", "canvas data-v2"), meta: { ...meta, title: "V2" } });
    const gem = readGemArchive(readArchiveDir(workspaceDir("up")));
    const art = gem.artifacts[0] as { type: string; html: string; title: string };
    expect(art.html).toContain("data-v2"); // gem reflects the SECOND save, not the first
    expect(art.title).toBe("V2");
  });
  it("refuses to save a bundle that fails the gate", async () => {
    await expect(saveMiniapp({ name: "bad", html: `<script>fetch("http://x/")</script>`, meta })).rejects.toThrow(/gate|sealed|network/i);
    expect(existsSync(miniappDir("bad"))).toBe(false);
  });
});
