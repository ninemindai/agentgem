import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, enableArtifacts, listDisabled } from "@agentgem/capture";

// The controller endpoints are thin delegators; this locks the contract the controller
// relies on: disable → listDisabled reflects it → enable clears it, all reversible.
let home: string, opts: { claudeDir: string; agentDir: string; codexDir: string; hermesDir: string };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "disable-ep-"));
  opts = { claudeDir: join(home, ".claude"), agentDir: join(home, ".agents", "skills"), codexDir: join(home, ".codex"), hermesDir: join(home, ".hermes") };
  mkdirSync(join(opts.claudeDir, "skills", "demo"), { recursive: true });
  writeFileSync(join(opts.claudeDir, "skills", "demo", "SKILL.md"), "---\ndescription: d\n---\n#demo");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("disable/enable endpoint contract", () => {
  it("disable → listDisabled shows it → enable removes it", () => {
    const d = disableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(d).toEqual([{ type: "skill", name: "demo", ok: true, message: expect.stringMatching(/archived/) }]);
    expect(listDisabled(opts)).toContainEqual({ type: "skill", name: "demo", source: "standalone" });
    const e = enableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(e[0].ok).toBe(true);
    expect(listDisabled(opts)).toHaveLength(0);
    expect(existsSync(join(opts.claudeDir, "skills", "demo", "SKILL.md"))).toBe(true);
  });
});
