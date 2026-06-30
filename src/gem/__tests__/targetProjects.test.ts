import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { detectTargetProject, discoverTargetProjects, scanRootsForTargets } from "@agentgem/testbed";
import { resolveDirs } from "@agentgem/model";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tp-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mkProject = (name: string, files: Record<string, string>): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return dir;
};

describe("detectTargetProject", () => {
  it("detects flue by flue.config.ts", () => {
    expect(detectTargetProject(mkProject("a", { "flue.config.ts": "export default {}" }))).toBe("flue");
  });

  it("detects flue by an @flue/* dependency", () => {
    const dir = mkProject("b", { "package.json": JSON.stringify({ dependencies: { "@flue/runtime": "^1" } }) });
    expect(detectTargetProject(dir)).toBe("flue");
  });

  it("detects eve by the eve dep AND an `eve …` script", () => {
    const dir = mkProject("c", {
      "package.json": JSON.stringify({ dependencies: { eve: "^0.15.0" }, scripts: { build: "eve build", dev: "eve dev" } }),
    });
    expect(detectTargetProject(dir)).toBe("eve");
  });

  it("does NOT treat a bare `eve` dependency (no eve script) as an eve project", () => {
    const dir = mkProject("d", { "package.json": JSON.stringify({ dependencies: { eve: "^1" }, scripts: { build: "tsc" } }) });
    expect(detectTargetProject(dir)).toBeNull();
  });

  it("returns null for a non-target project (a plain claude repo)", () => {
    const dir = mkProject("e", { "CLAUDE.md": "# hi", "package.json": JSON.stringify({ dependencies: { react: "^19" } }) });
    expect(detectTargetProject(dir)).toBeNull();
  });

  it("returns null for a directory with no package.json and no markers", () => {
    expect(detectTargetProject(mkProject("f", {}))).toBeNull();
  });
});

describe("discoverTargetProjects", () => {
  // resolveDirs treats its arg as the .claude dir; siblings hang off its parent.
  const dirsFor = (home: string) => resolveDirs(join(home, ".claude"));

  it("classifies a real project a claude session points at", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    try {
      // A real flue project on disk...
      const proj = join(home, "work", "my-flue-agent");
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, "flue.config.ts"), "export default {}");
      // ...that a claude session was run in.
      const sessDir = join(home, ".claude", "projects", "-encoded");
      mkdirSync(sessDir, { recursive: true });
      writeFileSync(join(sessDir, "s.jsonl"), `{"type":"user","cwd":${JSON.stringify(proj)}}\n`);

      const found = discoverTargetProjects(dirsFor(home));
      expect(found).toEqual([{ path: proj, target: "flue", lastUsed: expect.any(String) }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits candidate dirs that match no target signature", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    try {
      const proj = join(home, "plain-repo");        // a real dir, but not eve/flue
      mkdirSync(proj, { recursive: true });
      const sessDir = join(home, ".claude", "projects", "-plain");
      mkdirSync(sessDir, { recursive: true });
      writeFileSync(join(sessDir, "s.jsonl"), `{"type":"user","cwd":${JSON.stringify(proj)}}\n`);

      expect(discoverTargetProjects(dirsFor(home))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("scanRootsForTargets", () => {
  it("finds a target project nested a few levels under an allowlisted root", async () => {
    mkProject("code/org/my-eve", {
      "package.json": JSON.stringify({ dependencies: { eve: "^0.15.0" }, scripts: { build: "eve build" } }),
    });
    const found = await scanRootsForTargets([join(root, "code")]);
    expect(found).toEqual([{ path: join(root, "code", "org", "my-eve"), target: "eve", lastUsed: expect.any(String) }]);
  });

  it("does NOT descend into pruned artifact dirs (a flue.config.ts inside node_modules is ignored)", async () => {
    mkProject("code/pkg/node_modules/some-dep", { "flue.config.ts": "export default {}" });
    expect(await scanRootsForTargets([join(root, "code")])).toEqual([]);
  });

  it("respects maxDepth", async () => {
    mkProject("code/a/b/deep-flue", { "flue.config.ts": "export default {}" });
    // root=0, a=1, b=2, deep-flue=3 -> excluded at maxDepth 2, included at 3
    expect(await scanRootsForTargets([join(root, "code")], { maxDepth: 2 })).toEqual([]);
    expect(await scanRootsForTargets([join(root, "code")], { maxDepth: 3 })).toHaveLength(1);
  });

  it("dedups a project reachable from two overlapping roots", async () => {
    const proj = mkProject("code/app", { "flue.config.ts": "export default {}" });
    const found = await scanRootsForTargets([join(root, "code"), proj]);
    expect(found).toEqual([{ path: proj, target: "flue", lastUsed: expect.any(String) }]);
  });

  it("sorts newest-first by directory mtime", async () => {
    const older = mkProject("code/older", { "flue.config.ts": "x" });
    const newer = mkProject("code/newer", { "flue.config.ts": "x" });
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    const found = await scanRootsForTargets([join(root, "code")]);
    expect(found.map((c) => c.path)).toEqual([newer, older]);
  });

  it("ignores an unreadable / missing root without throwing", async () => {
    expect(await scanRootsForTargets([join(root, "does-not-exist")])).toEqual([]);
  });

  it("finds all projects across a wide tree (pool drains the full queue)", async () => {
    for (let i = 0; i < 40; i++) mkProject(`code/p${i}`, { "flue.config.ts": "x" });
    const found = await scanRootsForTargets([join(root, "code")], { concurrency: 4 });
    expect(found).toHaveLength(40);
  });
});
