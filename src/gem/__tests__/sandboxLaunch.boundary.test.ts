// src/gem/__tests__/sandboxLaunch.boundary.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltPolicy, type DeniedPath } from "@agentgem/run";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

// Run `sh -c <script>` under the generated policy; return true if it exited 0.
function runJailed(runDir: string, script: string, extraWritable: string[] = [], denied: DeniedPath[] = []): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", seatbeltPolicy(runDir, undefined, extraWritable, denied), "/bin/sh", "-c", script], { stdio: "pipe" });
    return true;
  } catch { return false; }
}

describe.skipIf(!onMac)("seatbelt boundary (macOS)", () => {
  it("denies a write OUTSIDE the run dir but allows one INSIDE", () => {
    const run = mkdtempSync(join(tmpdir(), "sbx-run-"));
    // Use /tmp for the "outside" dir — on macOS this is /private/tmp,
    // which is NOT covered by the policy's (subpath tmpdir()) clause
    // (tmpdir() resolves to /private/var/folders/...).
    const outside = mkdtempSync("/tmp/sbx-out-");
    try {
      const inside = join(run, "ok.txt");
      const evil = join(outside, "pwned.txt");
      expect(runJailed(run, `echo hi > ${inside}`)).toBe(true);
      expect(readFileSync(inside, "utf8")).toBe("hi\n");
      expect(runJailed(run, `echo bad > ${evil}`)).toBe(false);
      expect(existsSync(evil)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Regression for the original failure: the agent runs against its REAL config dir, so the
  // jail must allow its startup writes (e.g. session-env) there, while carving the escalation
  // vectors (settings.json hook, skills/) back out read-only via the deny block.
  it("allows config writes (session-env) but denies the sensitive paths (settings.json, skills)", () => {
    const run = mkdtempSync(join(tmpdir(), "sbx-run-"));
    // Config dir under /tmp (→ /private/tmp), NOT covered by the tmp clause — so writes there
    // succeed ONLY because it's passed as extra-writable, isolating the allow/deny behavior.
    const cfg = mkdtempSync("/tmp/sbx-cfg-");
    const denied: DeniedPath[] = [{ path: join(cfg, "settings.json"), kind: "file" }, { path: join(cfg, "skills"), kind: "dir" }];
    try {
      const scratch = join(cfg, "session-env", "abc123", "marker");
      const hook = join(cfg, "settings.json");
      const skill = join(cfg, "skills", "evil", "SKILL.md");
      // scratch write under the config dir → allowed
      expect(runJailed(run, `mkdir -p ${join(cfg, "session-env", "abc123")} && echo hi > ${scratch}`, [cfg], denied)).toBe(true);
      expect(readFileSync(scratch, "utf8")).toBe("hi\n");
      // hook + skill writes → denied even though the config dir is writable
      expect(runJailed(run, `echo pwned > ${hook}`, [cfg], denied)).toBe(false);
      expect(existsSync(hook)).toBe(false);
      expect(runJailed(run, `mkdir -p ${join(cfg, "skills", "evil")} && echo x > ${skill}`, [cfg], denied)).toBe(false);
      expect(existsSync(skill)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
