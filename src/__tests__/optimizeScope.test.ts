// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/optimizeScope.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, listDisabled } from "@agentgem/capture";
import { GemController } from "@agentgem/app/gem.controller";

// Project-targeted disable relocates the skill under <root>/.agentgem/disabled and
// listDisabled scoped to the project reads it back — the mechanism the /optimize
// project scope relies on (redirecting DisableOptions.claudeDir/etc at the project
// root, via projectDisableOpts in gem.controller.ts).
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "proj-"));
  const skillDir = join(root, ".claude", "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("project-scoped disable", () => {
  it("archives under the project root and lists it back", () => {
    const opts = { claudeDir: join(root, ".claude"), agentDir: join(root, ".agents"), codexDir: join(root, ".codex"), hermesDir: join(root, ".hermes") };
    // The /optimize project scope disables a project-local skill with source:"project"
    // (the label introspectProject tags every project skill with) and the claudeDir
    // redirection that points capture at <root>/.claude. capture's project branch
    // relocates <root>/.claude/skills/<name> to <root>/.agentgem/disabled/skills/project/,
    // and listDisabled(opts) round-trips it back as source:"project".
    const [r] = disableArtifacts([{ type: "skill", name: "demo", source: "project" }], opts);
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".claude", "skills", "demo"))).toBe(false);
    expect(existsSync(join(root, ".agentgem", "disabled", "skills", "project", "demo"))).toBe(true);
    expect(listDisabled(opts).some((d) => d.name === "demo" && d.source === "project")).toBe(true);
  });
});

describe("GET /optimize?root=", () => {
  // mergedInventory's global half calls introspectConfig() with no dir override, so this
  // exercises the real machine's ~/.claude transcripts (same as every other call site of
  // the global optimize branch) — bump the timeout past vitest's 15s default to match
  // the known real-FS-scan slowness on a dev machine with substantial session history.
  it("returns project rows as layer:project and includes global rows as layer:global", async () => {
    const c = new GemController();
    const res = await c.optimize({ query: { range: "all", root } });
    expect(res.artifacts.some((a) => a.name === "demo" && a.layer === "project")).toBe(true);
    expect(res.artifacts.every((a) => a.layer === "global" || a.layer === "project")).toBe(true);
  }, 60000);
});
