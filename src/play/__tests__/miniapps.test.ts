// src/play/__tests__/miniapps.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
// (rmSync is used both for temp-home cleanup and to simulate a delete landing mid-checkpoint)
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, deleteMiniapp, checkpointMiniapp, listMiniapps, miniappDir } from "@agentgem/play";
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
    expect(readFileSync(join(miniappDir("my-game"), "index.html"), "utf8")).toContain("canvas");
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

  it("deleteMiniapp removes the registry dir, commits, and drops the play-authored gem", async () => {
    await saveMiniapp({ name: "doomed", html: sealed, meta });
    expect(existsSync(workspaceDir("doomed"))).toBe(true);

    const res = await deleteMiniapp("doomed");
    expect(res.commit).toMatch(/^[0-9a-f]{7,40}$/);   // the removal is a real commit, so git can restore it
    expect(existsSync(miniappDir("doomed"))).toBe(false);
    expect(existsSync(workspaceDir("doomed"))).toBe(false);
    expect(listMiniapps().map((m) => m.name)).not.toContain("doomed");
  });

  // workspaceDir is a shared name-keyed namespace: a gem authored elsewhere can occupy the same path.
  // Deleting a miniapp must never take that unrelated, un-versioned gem with it.
  it("deleteMiniapp leaves a same-named gem that play did NOT author alone", async () => {
    await saveMiniapp({ name: "shared", html: sealed, meta });
    const manifestPath = join(workspaceDir("shared"), "gem.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { createdFrom: string };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, createdFrom: "observe" }, null, 2));

    await deleteMiniapp("shared");
    expect(existsSync(miniappDir("shared"))).toBe(false);  // the miniapp is gone
    expect(existsSync(manifestPath)).toBe(true);           // the foreign gem survives
  });

  // deleteMiniapp is the first destructive op in a registry that previously only appended, and
  // commitWithLock serializes the git commits but NOT the fs work around them. checkpointMiniapp reads
  // its html synchronously, before its first await -- so a studio turn finishing as the user clicks ✕
  // holds a PRE-deletion snapshot and would write it back out as a gem after the delete removed it. The
  // workspace gem is not under git, so a resurrected one is orphaned forever.
  //
  // Racing the two calls for real is timing-dependent (the checkpoint's commit is enqueued first, so it
  // usually wins), so this drives the hazard directly: apply the delete's fs effects while the checkpoint
  // is suspended at its first await, then let its tail run.
  it("a checkpoint in flight when a delete lands does not resurrect the deleted gem", async () => {
    await saveMiniapp({ name: "racy", html: sealed, meta });
    const checkpoint = checkpointMiniapp("racy");   // snapshot taken; now suspended on ensureRepo
    rmSync(miniappDir("racy"), { recursive: true, force: true });    // <- what deleteMiniapp does
    rmSync(workspaceDir("racy"), { recursive: true, force: true });  // <- what deletePlayGem does
    await checkpoint.catch(() => {});               // let its tail (gameGate -> writeGameGem) run

    expect(existsSync(workspaceDir("racy"))).toBe(false);  // the gem must STAY deleted
  });

  it("deleteMiniapp rejects an unknown name and a traversal attempt", async () => {
    await expect(deleteMiniapp("nope")).rejects.toThrow(/not found/i);
    await expect(deleteMiniapp("../escape")).rejects.toThrow();
  });
});

describe("saveMiniapp reconciles needs against the html", () => {
  // Guarded like every real generated bundle (scaffolds.ts, migrate.ts): gameGate's jsdom load-smoke
  // actually EXECUTES this script with no mcpAppClient shim present, so an unguarded call throws before
  // reconcile ever runs. The literal tool-name string still survives for deriveNeeds' static scan.
  const uses = (tool: string) => `<!doctype html><body><canvas></canvas><script>if (window.agentgemApp) window.agentgemApp.callTool("${tool}");</script></body>`;

  it("throws when the code calls a tool the meta does not declare", async () => {
    await expect(saveMiniapp({ name: "undeclared", html: uses("agentgem_subscribe_sessions"), meta }))
      .rejects.toThrow(/agentgem_subscribe_sessions.*live-session-events/s);
  });

  it("prunes a declared capability nothing uses, and reports it", async () => {
    const res = await saveMiniapp({ name: "over", html: sealed, meta: { ...meta, needs: ["live-session-events"] } });
    expect(res.prunedNeeds).toEqual(["live-session-events"]);
    const onDisk = JSON.parse(readFileSync(join(miniappDir("over"), "meta.json"), "utf8")) as { needs?: string[] };
    expect(onDisk.needs).toBeUndefined();
  });

  it("names the pruned capability in the commit message", async () => {
    await saveMiniapp({ name: "msg", html: sealed, meta: { ...meta, needs: ["invoke-agent"] } });
    const log = execFileSync("git", ["-C", join(home, "miniapps"), "log", "-1", "--pretty=%s"], { encoding: "utf8" });
    expect(log).toContain("pruned unused capability: invoke-agent");
  });

  it("writes the PRUNED needs into the game gem, not the authored ones", async () => {
    await saveMiniapp({ name: "gemprune", html: sealed, meta: { ...meta, needs: ["local-project-access"] } });
    const gem = readGemArchive(readArchiveDir(workspaceDir("gemprune")));
    expect((gem.artifacts[0] as { needs?: string[] }).needs).toBeUndefined();
  });

  it("keeps a capability the code actually uses", async () => {
    const res = await saveMiniapp({
      name: "kept", html: uses("agentgem_get_inventory"), meta: { ...meta, needs: ["local-project-access"] },
    });
    expect(res.prunedNeeds).toEqual([]);
    const gem = readGemArchive(readArchiveDir(workspaceDir("kept")));
    expect((gem.artifacts[0] as { needs?: string[] }).needs).toEqual(["local-project-access"]);
  });

  it("prunes a phantom session-data so an unbaked stub becomes portable (reconcile precedes assertPortable)", async () => {
    const res = await saveMiniapp({ name: "phantom", html: sealed, meta: { ...meta, needs: ["session-data"] } });
    expect(res.prunedNeeds).toEqual(["session-data"]);
  });
});

describe("saveMiniapp enforces literal tool names", () => {
  const shell = (js: string) => `<!doctype html><body><canvas></canvas><script>${js}</script></body>`;

  it("refuses a bundle that passes a tool name as a variable", async () => {
    const html = shell(`const t = "agentgem_get_inventory"; if (window.agentgemApp) window.agentgemApp.callTool(t);`);
    await expect(saveMiniapp({ name: "dyn", html, meta })).rejects.toThrow(/literal/i);
  });

  it("still saves a bundle that only mentions callTool(name) in a comment", async () => {
    const html = shell(`// pass a literal string, never callTool(name)\nconst x = 1;`);
    await expect(saveMiniapp({ name: "commented", html, meta })).resolves.toBeDefined();
  });
});
