// src/gem/__tests__/workspaces.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspacesRoot, workspaceDir, createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace,
} from "../workspaces.js";
import type { Gem, GemArtifact } from "../types.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "demo", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): GemArtifact => ({ type: "skill", name: n, source: "standalone", content });
const instr = (): GemArtifact => ({ type: "instructions", name: "soul", content: "be kind" });

describe("workspaces", () => {
  it("workspacesRoot honors AGENTGEM_HOME", () => {
    expect(workspacesRoot()).toBe(join(home, "workspaces"));
  });

  it("workspaceDir rejects names with separators or traversal", () => {
    expect(() => workspaceDir("../escape")).toThrow(/invalid workspace name/i);
    expect(() => workspaceDir("a/b")).toThrow(/invalid workspace name/i);
    // The rejection is a client-input error (400), so its reason reaches the caller
    // instead of being hidden behind an opaque 500.
    expect(() => workspaceDir("../escape")).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(workspaceDir("my-gem")).toBe(join(home, "workspaces", "my-gem"));
  });

  it("create writes the archive; list and read report it", () => {
    const s = createWorkspace("mp", gem([skill("review"), instr()]));
    expect(s.name).toBe("mp");
    expect(s.artifactCounts.skill).toBe(1);
    // the (type, name) artifact list is exposed so a consumer can restore the selection
    expect(s.artifacts).toContainEqual({ type: "skill", name: "review" });
    expect(s.artifacts.some((a) => a.type === "instructions")).toBe(true);
    expect(s.renderedTargets).toEqual([]);
    expect(existsSync(join(home, "workspaces", "mp", "gem.json"))).toBe(true);

    const list = listWorkspaces();
    expect(list.map((w) => w.name)).toEqual(["mp"]);

    const detail = readWorkspace("mp");
    expect(detail.files["skills/review/SKILL.md"]).toBe("# body");
    expect(detail.compatibility.claude.supported).toBeGreaterThan(0);
  });

  it("create throws on a duplicate name", () => {
    createWorkspace("dup", gem([skill("a")]));
    expect(() => createWorkspace("dup", gem([skill("b")]))).toThrow(/already exists/i);
  });

  it("renderTarget threads MaterializeOpts so a2a server mode reaches disk (not just card-only)", () => {
    createWorkspace("a2asrv", gem([skill("review"), instr()]));
    expect(renderTarget("a2asrv", "a2a").files["src/server.ts"]).toBeUndefined();
    expect(renderTarget("a2asrv", "a2a", { a2aServer: true }).files["src/server.ts"]).toContain("@a2a-js/sdk");
  });

  it("renderTarget writes .targets/<target>/ and clears stale files on re-render", () => {
    createWorkspace("rw", gem([skill("review"), instr()]));
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
    createWorkspace("gone", gem([skill("a")]));
    deleteWorkspace("gone");
    expect(existsSync(join(home, "workspaces", "gone"))).toBe(false);
    expect(listWorkspaces()).toEqual([]);
  });
});
