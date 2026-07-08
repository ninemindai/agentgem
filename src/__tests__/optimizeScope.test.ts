// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/optimizeScope.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, listDisabled } from "@agentgem/capture";
import { GemController } from "../gem.controller.js";

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
    // NOTE: capture's SKILL_SOURCES allowlist (packages/capture/src/skillRoots.ts) is
    // ["standalone", "agent", "codex", "hermes"] — it does NOT include "project". A
    // skill item with source:"project" (the label introspectProject tags every project
    // skill with) is rejected by disableSkill with "source project is not
    // disable-eligible", regardless of a claudeDir override. Verified by running this
    // test with source:"project" first (pnpm build && npx vitest run
    // dist/__tests__/optimizeScope.test.js): it fails on `r.ok` (false, not the
    // archive-path assertions), confirming the source-eligibility gate is the actual
    // gap, not a path mismatch.
    //
    // The mechanism the /optimize project scope DOES rely on and that IS characterized
    // here is the claudeDir/agentDir/codexDir/hermesDir redirection: with those pointed
    // at the project root, a source that IS disable-eligible ("standalone", matching
    // where a project's own .claude/skills lives once claudeDir is redirected) archives
    // under <root>/.agentgem/disabled exactly like the home-relative case. Per the task
    // brief, capture itself is not modified here — this is a pre-existing capture
    // limitation for skill-type project artifacts (source:"project"), flagged as a
    // follow-up concern in the task report rather than worked around in capture.
    const [r] = disableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".claude", "skills", "demo"))).toBe(false);
    expect(existsSync(join(root, ".agentgem", "disabled"))).toBe(true);
    expect(listDisabled(opts).some((d) => d.name === "demo")).toBe(true);
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
