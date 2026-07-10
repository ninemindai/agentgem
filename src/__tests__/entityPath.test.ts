// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { workspaceArtifactPath, parseWorkspaceArtifactPath, WORKSPACE_COLLECTIONS } from "@agentgem/model";

describe("workspaceArtifactPath", () => {
  it("mints a four-segment path for a skill", () => {
    expect(workspaceArtifactPath({ type: "skill", name: "agentback", source: "standalone" }))
      .toBe("workspace/skills/standalone/agentback");
  });

  it("percent-encodes a plugin source containing ':' and '@'", () => {
    expect(workspaceArtifactPath({ type: "subagent", name: "code-reviewer", source: "plugin:feature-dev@claude-plugins-official" }))
      .toBe("workspace/subagents/plugin%3Afeature-dev%40claude-plugins-official/code-reviewer");
  });

  // `codex:rules/default.rules` is a REAL instruction name. Unencoded, its '/' splits the path.
  it("mints a three-segment path for a source-less instruction, encoding a '/' in the name", () => {
    expect(workspaceArtifactPath({ type: "instructions", name: "codex:rules/default.rules" }))
      .toBe("workspace/instructions/codex%3Arules%2Fdefault.rules");
  });

  it("returns null for a body-less type (hooks and mcp servers have nothing to address)", () => {
    expect(workspaceArtifactPath({ type: "hook", name: "pre", source: "user" })).toBeNull();
    expect(workspaceArtifactPath({ type: "mcp_server", name: "gh", source: "user" })).toBeNull();
  });

  it("returns null for a skill with no source (a four-segment path needs one)", () => {
    expect(workspaceArtifactPath({ type: "skill", name: "orphan" })).toBeNull();
  });
});

describe("parseWorkspaceArtifactPath", () => {
  it("round-trips every artifact shape", () => {
    const cases = [
      { type: "skill", name: "agentback", source: "standalone" },
      { type: "subagent", name: "code-reviewer", source: "plugin:feature-dev@claude-plugins-official" },
      { type: "instructions", name: "codex:rules/default.rules" },
      { type: "instructions", name: "CLAUDE.md" },
    ];
    for (const a of cases) {
      const id = workspaceArtifactPath(a)!;
      expect(id, `mint failed for ${a.name}`).toBeTruthy();
      const back = parseWorkspaceArtifactPath(id);
      expect(back?.name, `name round-trip for ${id}`).toBe(a.name);
      expect(back?.source).toBe(a.source);
    }
  });

  it("distinguishes two plugins shipping the same bare name", () => {
    const a = workspaceArtifactPath({ type: "skill", name: "review", source: "plugin:alpha@m" })!;
    const b = workspaceArtifactPath({ type: "skill", name: "review", source: "plugin:beta@m" })!;
    expect(a).not.toBe(b);
    expect(parseWorkspaceArtifactPath(a)?.source).toBe("plugin:alpha@m");
    expect(parseWorkspaceArtifactPath(b)?.source).toBe("plugin:beta@m");
  });

  // Returns null, never throws — the route answers 404 for a hand-typed URL, not 500.
  it("returns null for malformed ids instead of throwing", () => {
    expect(parseWorkspaceArtifactPath("")).toBeNull();
    expect(parseWorkspaceArtifactPath("gems/@acme/tetris")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/gadgets/a/b")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/skills/only-three")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/instructions/a/b")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/skills/src/%ZZ")).toBeNull(); // bad %-escape
  });

  it("exports the declared collections", () => {
    expect([...WORKSPACE_COLLECTIONS]).toEqual(["skills", "subagents", "instructions"]);
  });
});
