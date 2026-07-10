// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/mcpServerRoot.test.ts
//
// get_artifact_detail accepts a caller-supplied `root` that flows into
// introspectProject(root) → filesystem reads. A prompt-injected chat agent could
// pass root="/" or "/etc" to read arbitrary paths. The tool must only introspect
// roots that are on the project allow-list (discovered ∪ recent), matching the
// server-side validation the chat launch path already applies.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldmineTools } from "../mcpServer.js";

const savedHome = process.env.HOME;
const savedAgentgemHome = process.env.AGENTGEM_HOME;
const cleanup: string[] = [];
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedAgentgemHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = savedAgentgemHome;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Fresh HOME/AGENTGEM_HOME plus one project seeded onto the recents allow-list.
function fixture(): { home: string; allowed: string } {
  const home = mkdtempSync(join(tmpdir(), "agentgem-home-")); cleanup.push(home);
  process.env.HOME = home;
  process.env.AGENTGEM_HOME = home;
  const allowed = mkdtempSync(join(tmpdir(), "agentgem-proj-")); cleanup.push(allowed);
  mkdirSync(join(home, ".agentgem"), { recursive: true });
  writeFileSync(
    join(home, ".agentgem", "recents.json"),
    JSON.stringify([{ path: allowed, flavor: "claude", name: "proj", lastUsed: "2026-01-01T00:00:00Z" }]),
  );
  return { home, allowed };
}

describe("get_artifact_detail root validation", () => {
  it("rejects a root outside the project allow-list", async () => {
    fixture();
    const tools = new GoldmineTools();
    await expect(
      tools.getArtifactDetailTool({ type: "skill", name: "x", root: "/etc" }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("allows a root that is on the recents allow-list", async () => {
    const { allowed } = fixture();
    const tools = new GoldmineTools();
    const r = await tools.getArtifactDetailTool({ type: "skill", name: "x", root: allowed });
    expect(r).toHaveProperty("detail");
  });

  it("works with no root (global config only)", async () => {
    fixture();
    const tools = new GoldmineTools();
    const r = await tools.getArtifactDetailTool({ type: "skill", name: "x" });
    expect(r).toHaveProperty("detail");
  });
});
