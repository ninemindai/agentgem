// src/gem/__tests__/sandboxLaunch.boundary.linux.test.ts
// The Linux counterpart of sandboxLaunch.boundary.test.ts: prove the generated bwrap
// argv actually confines filesystem writes to the run dir on real Linux. Gated to Linux
// with a working bubblewrap — and bwrap needs unprivileged user namespaces, which some
// AppArmor/CI configs disable, so we probe a trivial sandbox first and skip (not fail)
// when the kernel won't allow one. CI installs bubblewrap so this runs there.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { bwrapArgs } from "../sandboxLaunch.js";

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}
function bwrapWorks(): boolean {
  try { execFileSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "pipe" }); return true; }
  catch { return false; }
}
const onLinux = process.platform === "linux" && onPath("bwrap") && bwrapWorks();

// Run `sh -c <script>` under the generated bwrap argv; true iff it exited 0.
function runJailed(runDir: string, script: string): boolean {
  try {
    execFileSync("bwrap", [...bwrapArgs(runDir), "/bin/sh", "-c", script], { stdio: "pipe" });
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
});
