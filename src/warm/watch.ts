// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/watch.ts
//
// Trigger C's watch loop: recursively watch ~/.claude/projects, debounce a
// session's rapid appends, map changed transcripts to their project roots, and
// drive a targeted runWarmPass per changed root. Every external (fs.watch,
// timers, runner, root-mapping) is injectable so tests use zero real I/O.
import { watch as fsWatch } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDirs } from "@agentgem/model";
import { bucketTranscriptsByCwd } from "@agentgem/insight";
import { runWarmPass } from "./orchestrator.js";

export interface WarmWatch { stop(): void }
type WatchFn = (dir: string, cb: (evt: string, file: string | null) => void) => { close(): void };

/** Map changed transcript file paths to their project roots (cwd), deduped.
 *  Reuses bucketTranscriptsByCwd (cwd read from each transcript); unknown → skipped. */
export function mapFilesToRoots(claudeDir: string, changed: string[]): string[] {
  let bucket: Map<string, string[]>;
  try { bucket = bucketTranscriptsByCwd(claudeDir); } catch { return []; }
  const fileToRoot = new Map<string, string>();
  for (const [root, paths] of bucket) for (const p of paths) fileToRoot.set(resolve(p), root);
  const roots = new Set<string>();
  for (const f of changed) { const r = fileToRoot.get(resolve(f)); if (r) roots.add(r); }
  return [...roots];
}

export function startWarmWatch(opts: {
  claudeDir?: string;
  debounceMs?: number;
  watch?: WatchFn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  run?: (roots: string[]) => Promise<unknown>;
  toRoots?: (claudeDir: string, files: string[]) => string[];
} = {}): WarmWatch {
  const claudeDir = opts.claudeDir ?? resolveDirs().claudeDir;
  const projectsDir = join(claudeDir, "projects");
  const debounceMs = opts.debounceMs ?? 2500;
  const watchFn: WatchFn = opts.watch ?? ((dir, cb) => fsWatch(dir, { recursive: true }, (evt, f) => cb(evt, f as string | null)));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const run = opts.run ?? ((roots) => runWarmPass({ roots, topN: 1 }));
  const toRoots = opts.toRoots ?? mapFilesToRoots;

  const pending = new Set<string>();
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    const files = [...pending]; pending.clear();
    if (!files.length) return;
    const roots = toRoots(claudeDir, files);
    if (roots.length) void run(roots);
  };

  let sub: { close(): void };
  try {
    sub = watchFn(projectsDir, (_evt, file) => {
      if (!file || !file.endsWith(".jsonl")) return;
      pending.add(join(projectsDir, file));
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, debounceMs);
    });
  } catch {
    sub = { close() {} };   // best-effort: if the dir can't be watched, stay a no-op
  }

  return {
    stop() {
      try { sub.close(); } catch { /* ignore */ }
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
  };
}
