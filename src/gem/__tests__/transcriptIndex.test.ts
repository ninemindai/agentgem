// src/gem/__tests__/transcriptIndex.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTranscriptIndex, type TranscriptIndex, type UsageRow } from "@agentgem/capture";

// A stand-in transcript parser: returns whatever rows the test registered for a
// path, and counts how many times each path was actually (re)parsed so we can
// assert the index only reparses changed files.
function makeParser() {
  const rows = new Map<string, UsageRow[]>();
  const parseCount = new Map<string, number>();
  const parseFile = (path: string): UsageRow[] => {
    parseCount.set(path, (parseCount.get(path) ?? 0) + 1);
    return rows.get(path) ?? [];
  };
  return { rows, parseCount, parseFile };
}

// Write a file with explicit content so mtime/size actually move between writes.
function write(path: string, content: string, mtimeSec?: number) {
  writeFileSync(path, content);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

describe("transcript index — incremental global usage", () => {
  let dir: string;
  let index: TranscriptIndex;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidx-"));
    index = await openTranscriptIndex("memory://");
  });
  afterEach(async () => {
    await index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("folds per-file contributions with SUM invocations / SUM sessions / MAX lastUsedMs", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { rows, parseFile } = makeParser();
    rows.set(a, [{ type: "skill", name: "qa", invocations: 3, sessionsUsedIn: 1, lastUsedMs: 100 }]);
    rows.set(b, [{ type: "skill", name: "qa", invocations: 5, sessionsUsedIn: 1, lastUsedMs: 250 }]);

    const res = await index.syncGlobalUsage([a, b], "inv1", parseFile);
    expect(res.artifacts).toEqual([
      { type: "skill", name: "qa", root: null, invocations: 8, sessionsUsedIn: 2, lastUsedMs: 250 },
    ]);
  });

  it("reparses only changed files on the second sync; unchanged files are skipped", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a", 1_000);
    write(b, "b", 1_000);
    const { rows, parseCount, parseFile } = makeParser();
    rows.set(a, [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1, lastUsedMs: 10 }]);
    rows.set(b, [{ type: "mcp_server", name: "ctx", invocations: 2, sessionsUsedIn: 1, lastUsedMs: 20 }]);

    await index.syncGlobalUsage([a, b], "inv1", parseFile);
    expect(parseCount.get(a)).toBe(1);
    expect(parseCount.get(b)).toBe(1);

    // b changes (new content → new size + mtime), a is untouched.
    rows.set(b, [{ type: "mcp_server", name: "ctx", invocations: 9, sessionsUsedIn: 1, lastUsedMs: 99 }]);
    write(b, "b-changed-longer", 2_000);

    const res = await index.syncGlobalUsage([a, b], "inv1", parseFile);
    expect(parseCount.get(a)).toBe(1); // a NOT reparsed
    expect(parseCount.get(b)).toBe(2); // b reparsed
    const ctx = res.artifacts.find((x) => x.name === "ctx");
    expect(ctx?.invocations).toBe(9); // reflects the updated parse
  });

  it("prunes files that disappear from the path set", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { rows, parseFile } = makeParser();
    rows.set(a, [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1, lastUsedMs: 10 }]);
    rows.set(b, [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1, lastUsedMs: 20 }]);

    await index.syncGlobalUsage([a, b], "inv1", parseFile);
    rmSync(b);
    const res = await index.syncGlobalUsage([a], "inv1", parseFile);
    expect(res.artifacts).toEqual([
      { type: "skill", name: "qa", root: null, invocations: 1, sessionsUsedIn: 1, lastUsedMs: 10 },
    ]);
  });

  it("rebuilds when the inventory digest changes (resolution changed)", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { rows, parseCount, parseFile } = makeParser();
    rows.set(a, [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1, lastUsedMs: 10 }]);

    await index.syncGlobalUsage([a], "inv1", parseFile);
    expect(parseCount.get(a)).toBe(1);

    // Same file, unchanged on disk, but the inventory digest moved → full rebuild,
    // so the file is reparsed even though its mtime/size are identical.
    rows.set(a, [{ type: "skill", name: "qa", invocations: 7, sessionsUsedIn: 1, lastUsedMs: 10 }]);
    const res = await index.syncGlobalUsage([a], "inv2", parseFile);
    expect(parseCount.get(a)).toBe(2);
    expect(res.artifacts[0].invocations).toBe(7);
  });

  it("persists across reopen (on-disk datadir) and reparses nothing when unchanged", async () => {
    const store = mkdtempSync(join(tmpdir(), "tidx-store-"));
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { rows, parseCount, parseFile } = makeParser();
    rows.set(a, [{ type: "skill", name: "qa", invocations: 4, sessionsUsedIn: 1, lastUsedMs: 10 }]);

    const first = await openTranscriptIndex(store);
    await first.syncGlobalUsage([a], "inv1", parseFile);
    await first.close();
    expect(parseCount.get(a)).toBe(1);

    const second = await openTranscriptIndex(store);
    const res = await second.syncGlobalUsage([a], "inv1", parseFile);
    await second.close();
    expect(parseCount.get(a)).toBe(1); // unchanged → not reparsed after reopen
    expect(res.artifacts[0].invocations).toBe(4);
    rmSync(store, { recursive: true, force: true });
  });
});
