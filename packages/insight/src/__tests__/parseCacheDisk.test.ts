// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The PERSISTED tier of the incremental parse cache. The in-memory map was already
// incremental — a re-scan re-reads only files whose (mtime, size) moved — but it died with
// the process, so a fresh CLI run re-parsed every transcript to learn one had changed.
//
// These assertions are deliberately made against fixed inputs in a temp home. End-to-end
// equality cannot be asserted on a live machine: two *cold* scans of a developer's real
// ~/.claude disagree with each other, because agent sessions append while you measure.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let claude: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "parse-cache-"));
  claude = join(home, "projects", "proj");
  mkdirSync(claude, { recursive: true });
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;   // redirects agentgemHome(), so the cache lands here
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENTGEM_HOME;
  else process.env.AGENTGEM_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

/** A minimal claude transcript the scanner will parse into one SessionStat. */
function transcript(id: string, lines = 3): void {
  const rows = Array.from({ length: lines }, (_, i) => JSON.stringify({
    sessionId: id, type: i % 2 ? "assistant" : "user", cwd: "/tmp/proj",
    timestamp: new Date(Date.UTC(2026, 6, 28, 0, i)).toISOString(),
    message: { role: i % 2 ? "assistant" : "user", content: "x", usage: { input_tokens: 1, output_tokens: 2 } },
  }));
  writeFileSync(join(claude, `${id}.jsonl`), rows.join("\n"));
}

const cachePath = () => join(home, ".agentgem", "cache", "session-parse.json");

describe("persisted parse cache", () => {
  it("round-trips across a fresh module load, so a new process starts warm", async () => {
    transcript("a");
    transcript("b");

    const first = await import("../sources.js");
    // Populate the in-memory map by scanning, then persist it.
    await first.BUILTIN_SOURCES.find((s) => s.id === "claude")!.scanSessions!([claude]);
    await first.saveParseCacheToDisk();
    expect(existsSync(cachePath())).toBe(true);

    // A brand-new module instance is the moral equivalent of a new process.
    vi.resetModules();
    const second = await import("../sources.js");
    await second.loadParseCacheFromDisk();

    // Nothing changed on disk, so a scan now serves both files from the hydrated cache.
    const stats = await second.BUILTIN_SOURCES.find((s) => s.id === "claude")!.scanSessions!([claude]);
    expect(stats).toHaveLength(2);
  });

  it("re-parses only what moved: a rewritten transcript invalidates its own entry alone", async () => {
    transcript("a");
    transcript("b");
    const mod = await import("../sources.js");
    const claudeSpec = mod.BUILTIN_SOURCES.find((s) => s.id === "claude")!;
    const before = await claudeSpec.scanSessions!([claude]);
    await mod.saveParseCacheToDisk();

    // 'b' grows; 'a' is untouched. Size changes, so only b's key is invalidated.
    transcript("b", 7);
    const after = await claudeSpec.scanSessions!([claude]);

    const msgsOf = (rows: typeof after, id: string) => rows.find((r) => r.sessionId === id)?.msgs;
    expect(msgsOf(after, "a")).toBe(msgsOf(before, "a"));      // reused, unchanged
    expect(msgsOf(after, "b")).not.toBe(msgsOf(before, "b"));  // re-parsed
  });

  it("tolerates a corrupt cache file by starting cold", async () => {
    mkdirSync(join(home, ".agentgem", "cache"), { recursive: true });
    writeFileSync(cachePath(), "{not json");
    transcript("a");

    const mod = await import("../sources.js");
    await expect(mod.loadParseCacheFromDisk()).resolves.not.toThrow();
    const stats = await mod.BUILTIN_SOURCES.find((s) => s.id === "claude")!.scanSessions!([claude]);
    expect(stats).toHaveLength(1);
  });

  // clearParseCache() is a test seam meaning "make the next parse real". A persisted tier
  // would defeat it, and deleting the operator's file to avoid that would be a destructive
  // side-effect of running tests — so it disables the tier for the process instead.
  it("clearParseCache disables the disk tier rather than deleting the file", async () => {
    transcript("a");
    const mod = await import("../sources.js");
    await mod.BUILTIN_SOURCES.find((s) => s.id === "claude")!.scanSessions!([claude]);
    await mod.saveParseCacheToDisk();
    expect(existsSync(cachePath())).toBe(true);

    mod.clearParseCache();
    await mod.saveParseCacheToDisk();     // must not overwrite with an emptied map
    await mod.loadParseCacheFromDisk();   // must not re-hydrate
    expect(existsSync(cachePath())).toBe(true); // the operator's file survives
  });
});
