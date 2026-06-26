// src/gem/__tests__/sandboxLaunch.boundary.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltPolicy } from "../sandboxLaunch.js";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

// Run `sh -c <script>` under the generated policy; return true if it exited 0.
function runJailed(runDir: string, script: string): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", seatbeltPolicy(runDir), "/bin/sh", "-c", script], { stdio: "pipe" });
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
});
