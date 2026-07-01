// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWarmWatch, mapFilesToRoots } from "../watch.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("startWarmWatch", () => {
  it("coalesces a burst of .jsonl events into one run and maps to roots", () => {
    let fire!: (evt: string, file: string | null) => void;
    let pendingTimer: (() => void) | null = null;
    const runs: string[][] = [];
    const w = startWarmWatch({
      claudeDir: "/x",
      watch: (_dir, cb) => { fire = cb; return { close() {} }; },
      setTimer: (fn) => { pendingTimer = fn; return 1; },
      clearTimer: () => { pendingTimer = null; },
      toRoots: (_cd, files) => files.map((f) => f.replace(/\/[^/]+\.jsonl$/, "")), // dir as "root"
      run: async (roots) => { runs.push(roots); },
    });
    fire("change", "-proj-a/s1.jsonl");
    fire("change", "-proj-a/s2.jsonl");     // same project, still within debounce
    fire("change", "-proj-b/s1.jsonl");
    fire("change", null);                    // ignored
    fire("change", "notes.txt");             // non-jsonl ignored
    expect(runs).toEqual([]);                // nothing ran yet (debounced)
    pendingTimer!();                          // fire the debounce
    expect(runs.length).toBe(1);
    expect(new Set(runs[0])).toEqual(new Set(["/x/projects/-proj-a", "/x/projects/-proj-b"]));
    w.stop();
  });

  it("stop() clears a pending timer so no run fires after stop", () => {
    let pendingTimer: (() => void) | null = null;
    let cleared = false;
    const runs: string[][] = [];
    let fire!: (evt: string, file: string | null) => void;
    const w = startWarmWatch({
      claudeDir: "/x",
      watch: (_dir, cb) => { fire = cb; return { close() {} }; },
      setTimer: (fn) => { pendingTimer = fn; return 1; },
      clearTimer: () => { cleared = true; pendingTimer = null; },
      toRoots: (_cd, files) => files,
      run: async (roots) => { runs.push(roots); },
    });
    fire("change", "-proj-a/s1.jsonl");
    w.stop();
    expect(cleared).toBe(true);
    expect(runs).toEqual([]);
  });

  it("mapFilesToRoots resolves a transcript's project root via its cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "watch-"));
    const claudeDir = join(dir, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    const f = join(projDir, "s.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/proj" }) + "\n");
    expect(mapFilesToRoots(claudeDir, [f])).toEqual(["/proj"]);
    expect(mapFilesToRoots(claudeDir, [join(projDir, "gone.jsonl")])).toEqual([]); // unknown → skipped
  });
});
