// src/gem/__tests__/workspaces.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspacesRoot, workspaceDir, createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace,
} from "../workspaces.js";
import type { Pack, PackArtifact } from "../types.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

const pack = (artifacts: PackArtifact[]): Pack => ({ name: "demo", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): PackArtifact => ({ type: "skill", name: n, source: "standalone", content });
const instr = (): PackArtifact => ({ type: "instructions", name: "soul", content: "be kind" });

describe("workspaces", () => {
  it("workspacesRoot honors AGENTGEM_HOME", () => {
    expect(workspacesRoot()).toBe(join(home, "workspaces"));
  });

  it("workspaceDir rejects names with separators or traversal", () => {
    expect(() => workspaceDir("../escape")).toThrow(/invalid workspace name/i);
    expect(() => workspaceDir("a/b")).toThrow(/invalid workspace name/i);
    expect(workspaceDir("my-pack")).toBe(join(home, "workspaces", "my-pack"));
  });

  it("create writes the archive; list and read report it", () => {
    const s = createWorkspace("mp", pack([skill("review"), instr()]));
    expect(s.name).toBe("mp");
    expect(s.artifactCounts.skill).toBe(1);
    expect(s.renderedTargets).toEqual([]);
    expect(existsSync(join(home, "workspaces", "mp", "pack.json"))).toBe(true);

    const list = listWorkspaces();
    expect(list.map((w) => w.name)).toEqual(["mp"]);

    const detail = readWorkspace("mp");
    expect(detail.files["skills/review/SKILL.md"]).toBe("# body");
    expect(detail.compatibility.claude.supported).toBeGreaterThan(0);
  });

  it("create throws on a duplicate name", () => {
    createWorkspace("dup", pack([skill("a")]));
    expect(() => createWorkspace("dup", pack([skill("b")]))).toThrow(/already exists/i);
  });

  it("renderTarget writes .targets/<target>/ and clears stale files on re-render", () => {
    createWorkspace("rw", pack([skill("review"), instr()]));
    const r = renderTarget("rw", "eve");
    expect(r.target).toBe("eve");
    expect(r.files["agent/skills/review.md"]).toBe("# body");
    expect(existsSync(join(home, "workspaces", "rw", ".targets", "eve", "agent", "skills", "review.md"))).toBe(true);
    expect(readWorkspace("rw").renderedTargets).toEqual(["eve"]);

    // re-render claude after also rendering eve: stale eve files must not leak into claude
    renderTarget("rw", "claude");
    const claudeDir = join(home, "workspaces", "rw", ".targets", "claude");
    expect(existsSync(join(claudeDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "agent"))).toBe(false);
  });

  it("delete removes the workspace; listing an empty root is []", () => {
    createWorkspace("gone", pack([skill("a")]));
    deleteWorkspace("gone");
    expect(existsSync(join(home, "workspaces", "gone"))).toBe(false);
    expect(listWorkspaces()).toEqual([]);
  });
});
