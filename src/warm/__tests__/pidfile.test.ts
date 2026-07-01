// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidfile, releasePidfile } from "../pidfile.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("pidfile", () => {
  it("acquires a free path, then blocks a second acquire (own live pid), and release frees it", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-"));
    const p = join(dir, ".agentgem", "warm.pid");
    expect(acquirePidfile(p)).toBe(true);      // free → acquired (writes process.pid)
    expect(acquirePidfile(p)).toBe(false);     // our own pid is alive → blocked
    releasePidfile(p);
    expect(existsSync(p)).toBe(false);
    expect(acquirePidfile(p)).toBe(true);      // free again
  });

  it("overwrites a stale (dead) pid", () => {
    dir = mkdtempSync(join(tmpdir(), "pid2-"));
    const p = join(dir, "warm.pid");
    writeFileSync(p, "999999999");             // a pid that is not alive
    expect(acquirePidfile(p)).toBe(true);
  });
});
