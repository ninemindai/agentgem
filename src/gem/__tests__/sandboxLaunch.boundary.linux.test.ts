// src/gem/__tests__/sandboxLaunch.boundary.linux.test.ts
// The Linux counterpart of sandboxLaunch.boundary.test.ts: prove the generated bwrap
// argv actually confines filesystem writes to the run dir on real Linux. Gated to Linux
// with a working bubblewrap — and bwrap needs unprivileged user namespaces, which some
// AppArmor/CI configs disable, so we probe a trivial sandbox first and skip (not fail)
// when the kernel won't allow one. CI installs bubblewrap so this runs there.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { bwrapArgs, type DeniedPath, type MaskPlaceholders } from "../sandboxLaunch.js";

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}
function bwrapWorks(): boolean {
  try { execFileSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "pipe" }); return true; }
  catch { return false; }
}
const onLinux = process.platform === "linux" && onPath("bwrap") && bwrapWorks();

// Read-only placeholders for masking absent sensitive paths (mirrors sandbox.ensureMaskPlaceholders).
function masks(root: string): MaskPlaceholders {
  const dir = join(root, "mask-empty"); mkdirSync(dir, { recursive: true });
  const file = join(root, "mask-empty.json"); writeFileSync(file, "{}");
  return { file, dir };
}

// Run `sh -c <script>` under the generated bwrap argv; true iff it exited 0.
function runJailed(runDir: string, script: string, extraWritable: string[] = [], denied: DeniedPath[] = [], m?: MaskPlaceholders): boolean {
  try {
    execFileSync("bwrap", [...bwrapArgs(runDir, undefined, extraWritable, denied, m), "/bin/sh", "-c", script], { stdio: "pipe" });
    return true;
  } catch { return false; }
}

describe.skipIf(!onLinux)("bubblewrap boundary (Linux)", () => {
  it("denies a write OUTSIDE the run dir but allows one INSIDE", () => {
    // Put both dirs under $HOME, which is read-only inside the sandbox except for the
    // explicit --bind of runDir. So the INSIDE write exercises the runDir bind, and a
    // containment FAILURE on the OUTSIDE write would create a real file on the host.
    const run = mkdtempSync(join(homedir(), "bwx-run-"));
    const outside = join(homedir(), `.bwx-pwned-${process.pid}`);
    try {
      const inside = join(run, "ok.txt");
      expect(runJailed(run, `echo hi > ${inside}`)).toBe(true);
      expect(readFileSync(inside, "utf8")).toBe("hi\n");
      expect(runJailed(run, `echo bad > ${outside}`)).toBe(false);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  // Regression for the original failure: the agent runs against its REAL config dir, so the
  // jail allows its startup writes (session-env) there while re-binding the escalation vectors
  // (settings.json, skills/) read-only via --ro-bind-try.
  it("allows config writes (session-env) but denies the sensitive paths (settings.json, skills)", () => {
    const run = mkdtempSync(join(homedir(), "bwx-run-"));
    const cfg = mkdtempSync(join(homedir(), "bwx-cfg-"));     // stands in for ~/.claude
    // The sensitive paths must EXIST for --ro-bind-try to re-bind them read-only.
    mkdirSync(join(cfg, "skills"), { recursive: true });
    writeFileSync(join(cfg, "settings.json"), "{}");
    const denied: DeniedPath[] = [{ path: join(cfg, "settings.json"), kind: "file" }, { path: join(cfg, "skills"), kind: "dir" }];
    try {
      const scratch = join(cfg, "session-env", "abc123", "marker");
      const hook = join(cfg, "settings.json");
      const skill = join(cfg, "skills", "evil", "SKILL.md");
      expect(runJailed(run, `mkdir -p ${join(cfg, "session-env", "abc123")} && echo hi > ${scratch}`, [cfg], denied)).toBe(true);
      expect(readFileSync(scratch, "utf8")).toBe("hi\n");
      expect(runJailed(run, `echo pwned > ${hook}`, [cfg], denied)).toBe(false);
      expect(readFileSync(hook, "utf8")).toBe("{}");   // unchanged
      expect(runJailed(run, `mkdir -p ${join(cfg, "skills", "evil")} && echo x > ${skill}`, [cfg], denied)).toBe(false);
      expect(existsSync(skill)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  // The follow-up fix: when a sensitive path does NOT exist yet, a read-only placeholder is
  // masked over it so the agent cannot CREATE it (the --ro-bind-try fallback would have let it).
  it("masks an ABSENT sensitive path so the agent cannot create it", () => {
    const run = mkdtempSync(join(homedir(), "bwx-run-"));
    const cfg = mkdtempSync(join(homedir(), "bwx-cfg-"));   // ~/.claude with NO settings.json / skills yet
    const m = masks(cfg);
    const denied: DeniedPath[] = [{ path: join(cfg, "settings.json"), kind: "file" }, { path: join(cfg, "skills"), kind: "dir" }];
    try {
      const hook = join(cfg, "settings.json");
      const skill = join(cfg, "skills", "evil", "SKILL.md");
      // config dir is writable (scratch ok) but the absent sensitive paths are masked read-only
      expect(runJailed(run, `echo hi > ${join(cfg, "ok.txt")}`, [cfg], denied, m)).toBe(true);
      expect(runJailed(run, `echo pwned > ${hook}`, [cfg], denied, m)).toBe(false);
      expect(existsSync(hook)).toBe(false);
      expect(runJailed(run, `mkdir -p ${join(cfg, "skills", "evil")} && echo x > ${skill}`, [cfg], denied, m)).toBe(false);
      expect(existsSync(skill)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
