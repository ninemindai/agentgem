// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/transcriptIndex.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTranscriptIndex, type TranscriptIndex } from "@agentgem/capture";
import type { FileUsage } from "@agentgem/insight";

// A stand-in parser: returns whatever FileUsage the test registered for a path, and counts
// how many times each path was actually (re)parsed, so we can assert what does NOT reparse.
function makeParser() {
  const files = new Map<string, FileUsage>();
  const parseCount = new Map<string, number>();
  const parseFile = (path: string): FileUsage => {
    parseCount.set(path, (parseCount.get(path) ?? 0) + 1);
    return files.get(path) ?? { raw: [], hooks: [] };
  };
  return { files, parseCount, parseFile };
}

function write(path: string, content: string, mtimeSec?: number) {
  writeFileSync(path, content);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

describe("transcript index — raw rows, inventory-independent", () => {
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

  it("stores raw rows keyed by path and returns them with hook rows; lastUsedMs comes from the file's mtime", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a");
    const aMtime = statSync(a).mtimeMs;
    const { files, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "x:qa", invocations: 3 }], hooks: [{ name: "stopper", invocations: 1 }] });

    const out = await index.syncUsage([a], "hooks1", parseFile);
    expect(out.raw).toEqual([{ path: a, kind: "skill", token: "x:qa", invocations: 3, lastUsedMs: aMtime }]);
    expect(out.hooks).toEqual([{ path: a, name: "stopper", invocations: 1, lastUsedMs: aMtime }]);
  });

  it("reparses only changed files; unchanged files are skipped", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a", 1_000);
    write(b, "b", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [] });
    files.set(b, { raw: [{ kind: "mcp_server", token: "ctx", invocations: 2 }], hooks: [] });

    await index.syncUsage([a, b], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(1);
    expect(parseCount.get(b)).toBe(1);

    files.set(b, { raw: [{ kind: "mcp_server", token: "ctx", invocations: 9 }], hooks: [] });
    write(b, "b-changed-longer", 2_000);

    const out = await index.syncUsage([a, b], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(1); // a NOT reparsed
    expect(parseCount.get(b)).toBe(2);
    expect(out.raw.find((r) => r.path === b)?.invocations).toBe(9);
  });

  // The whole point: the inventory is no longer an input to the stored rows, so a skill
  // install cannot invalidate them. There is no digest to pass.
  it("does NOT reparse when only the skill/mcp inventory changes", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [] });

    await index.syncUsage([a], "hooks1", parseFile);
    await index.syncUsage([a], "hooks1", parseFile); // same hook digest, unchanged file
    expect(parseCount.get(a)).toBe(1);
  });

  // T-B: the A1 column mechanism. Unchanged bytes + a changed hook_digest forces a reparse of
  // THAT file; unchanged bytes + the same hook_digest never does.
  it("T-B: a changed hook_digest reparses a byte-unchanged file; an unchanged hook_digest does not", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "old", invocations: 1 }] });

    await index.syncUsage([a], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(1);

    await index.syncUsage([a], "hooks1", parseFile); // same digest, same bytes
    expect(parseCount.get(a)).toBe(1); // NOT reparsed

    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "new", invocations: 2 }] });
    const out = await index.syncUsage([a], "hooks2", parseFile); // digest changed, bytes did not
    expect(parseCount.get(a)).toBe(2); // reparsed despite same mtime/size
    expect(out.hooks.map((h) => ({ name: h.name, invocations: h.invocations }))).toEqual([{ name: "new", invocations: 2 }]);
    expect(out.raw.map((r) => ({ kind: r.kind, token: r.token, invocations: r.invocations }))).toEqual([
      { kind: "skill", token: "qa", invocations: 1 }, // raw rows survive the hook-driven reparse
    ]);
  });

  it("prunes files that disappear from the path set", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { files, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [] });
    files.set(b, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "h", invocations: 1 }] });

    await index.syncUsage([a, b], "hooks1", parseFile);
    rmSync(b);
    const out = await index.syncUsage([a], "hooks1", parseFile);
    expect(out.raw.map((r) => r.path)).toEqual([a]);
    expect(out.hooks).toEqual([]);
  });

  // T-A (CRITICAL regression): the P1 bug. The old design wiped `transcript_file` wholesale on
  // a hook-digest change, so the prune loop (which reads `transcript_file`) saw nothing to
  // prune and a deleted file's raw_usage/hook_usage rows leaked forever. hook_digest is now a
  // per-row column, so transcript_file is never wiped, and pruning stays correct across a
  // digest change.
  it("T-A: prunes a deleted file's rows even across a hook_digest change in the same sync", async () => {
    // On-disk (not memory://) so we can re-open a raw connection afterward and inspect
    // raw_usage/hook_usage directly. That matters: syncUsage's own return value is a JOIN to
    // transcript_file, so a wipe-based bug that deletes transcript_file but leaves raw_usage/
    // hook_usage rows behind would still LOOK clean through that JOIN — the leaked rows are
    // invisible to callers today but sit in the table forever. Assert against the tables
    // themselves, not just the join, so this regression test can't be fooled by that.
    const storeDir = mkdtempSync(join(tmpdir(), "tidx-prune-"));
    const store = join(storeDir, "transcript-index.db");
    const onDisk = await openTranscriptIndex(store);

    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { files, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [] });
    files.set(b, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "h", invocations: 1 }] });

    await onDisk.syncUsage([a, b], "hooks1", parseFile);
    rmSync(b); // b vanishes from disk
    const out = await onDisk.syncUsage([a], "hooks2", parseFile); // AND the hook digest changes
    await onDisk.close();

    expect(out.raw.some((r) => r.path === b)).toBe(false);
    expect(out.hooks.some((h) => h.path === b)).toBe(false);
    expect(out.raw.map((r) => r.path)).toEqual([a]);

    const check = new DatabaseSync(store);
    expect((check.prepare("SELECT count(*) AS n FROM raw_usage WHERE path = ?1").get(b) as { n: number }).n).toBe(0);
    expect((check.prepare("SELECT count(*) AS n FROM hook_usage WHERE path = ?1").get(b) as { n: number }).n).toBe(0);
    expect((check.prepare("SELECT count(*) AS n FROM transcript_file WHERE path = ?1").get(b) as { n: number }).n).toBe(0);
    check.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  // T-C: a read failure (scanFileUsage's `failed: true`) must not be recorded as "parsed" —
  // otherwise the file would never be retried and would silently read as zero usage forever.
  it("T-C: a failed read is not recorded in transcript_file and is retried next sync; other files are unaffected", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { files, parseCount, parseFile: parseOk } = makeParser();
    files.set(b, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [] });
    const parseFile = (path: string): FileUsage => {
      if (path === a) {
        parseCount.set(a, (parseCount.get(a) ?? 0) + 1);
        return { raw: [], hooks: [], failed: true };
      }
      return parseOk(path);
    };

    const out = await index.syncUsage([a, b], "hooks1", parseFile);
    expect(out.raw).toEqual([{ path: b, kind: "skill", token: "qa", invocations: 1, lastUsedMs: statSync(b).mtimeMs }]);
    expect(parseCount.get(a)).toBe(1);

    // a still fails; it was never recorded, so it is unconditionally retried.
    await index.syncUsage([a, b], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(2); // retried
    expect(parseCount.get(b)).toBe(1); // b, already up to date, was NOT reparsed
  });

  // T-D (regression): an UNCAUGHT exception thrown by parseFile — not the typed `{failed:true}`
  // contract, a real `throw` — must converge on the same handling as a read failure: it must
  // not propagate out of the BEGIN/COMMIT transaction and abort the whole sync. One pathological
  // transcript must not block usage indexing for the rest of the corpus, and it must be retried
  // next sync rather than silently recorded as done.
  it("T-D: an uncaught parseFile exception does not abort the sync; the file is retried next sync", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { files, parseFile: parseOk } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "a-token", invocations: 1 }], hooks: [] });
    files.set(b, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [] });
    let throwForA = true;
    const throwingParse = (path: string): FileUsage => {
      if (path === a && throwForA) throw new Error("pathological transcript");
      return parseOk(path);
    };

    // 1. The whole sync resolves rather than rejecting.
    const out = await index.syncUsage([a, b], "hooks1", throwingParse);
    // 2. b's legitimate update survived — the transaction was not rolled back.
    expect(out.raw.some((r) => r.path === b && r.token === "qa")).toBe(true);
    expect(out.raw.some((r) => r.path === a)).toBe(false);

    // 3. a was not recorded as done, so once it stops throwing it is reparsed and its rows land.
    throwForA = false;
    const out2 = await index.syncUsage([a, b], "hooks1", throwingParse);
    expect(out2.raw.some((r) => r.path === a && r.token === "a-token")).toBe(true);
  });

  it("persists across reopen and reparses nothing when unchanged", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tidx-store-"));
    const store = join(storeDir, "transcript-index.db");
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 4 }], hooks: [] });

    const first = await openTranscriptIndex(store);
    await first.syncUsage([a], "hooks1", parseFile);
    await first.close();
    expect(parseCount.get(a)).toBe(1);

    const second = await openTranscriptIndex(store);
    const out = await second.syncUsage([a], "hooks1", parseFile);
    await second.close();
    expect(parseCount.get(a)).toBe(1);
    expect(out.raw[0].invocations).toBe(4);
    rmSync(storeDir, { recursive: true, force: true });
  });

  // T-F: an on-disk v1 database migrates cleanly to v2 — global_usage is dropped, the new
  // tables exist and are empty, and schema_version is bumped. No hand-written data migration.
  it("T-F: migrates an on-disk schema_version=1 database to v2", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tidx-migrate-"));
    const store = join(storeDir, "transcript-index.db");

    const v1 = new DatabaseSync(store);
    v1.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE transcript_file (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size REAL NOT NULL);
      CREATE TABLE global_usage (
        path TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
        invocations INTEGER NOT NULL, sessions_used_in INTEGER NOT NULL, last_used_ms REAL,
        PRIMARY KEY (path, type, name)
      );
    `);
    v1.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '1')").run();
    v1.prepare("INSERT INTO meta(key, value) VALUES('inv_digest', 'stale-digest')").run();
    v1.prepare("INSERT INTO transcript_file(path, mtime_ms, size) VALUES('/old/a.jsonl', 1, 2)").run();
    v1.prepare(
      "INSERT INTO global_usage(path, type, name, invocations, sessions_used_in, last_used_ms) VALUES('/old/a.jsonl', 'skill', 'qa', 1, 1, 1)",
    ).run();
    v1.close();

    const migrated = await openTranscriptIndex(store);
    await migrated.close();

    const check = new DatabaseSync(store);
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).not.toContain("global_usage");
    expect(tables).toContain("raw_usage");
    expect(tables).toContain("hook_usage");
    expect(tables).toContain("transcript_file");
    expect((check.prepare("SELECT count(*) AS n FROM transcript_file").get() as { n: number }).n).toBe(0);
    expect((check.prepare("SELECT count(*) AS n FROM raw_usage").get() as { n: number }).n).toBe(0);
    expect((check.prepare("SELECT count(*) AS n FROM hook_usage").get() as { n: number }).n).toBe(0);
    expect((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("2");
    expect(check.prepare("SELECT value FROM meta WHERE key = 'inv_digest'").get()).toBeUndefined();
    check.close();
    rmSync(storeDir, { recursive: true, force: true });
  });
});

describe("peekUsage — stale-while-revalidate read (no parse)", () => {
  let dir: string;
  let index: TranscriptIndex;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "peek-")); index = await openTranscriptIndex("memory://"); });
  afterEach(async () => { await index.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns stored rows and pending:true WITHOUT parsing an unsynced file", async () => {
    const a = join(dir, "a.jsonl"); write(a, "a");
    const b = join(dir, "b.jsonl"); write(b, "b");
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "x:qa", invocations: 2 }], hooks: [] });

    await index.syncUsage([a], "h1", parseFile);   // index only `a`; `b` is new/unindexed
    expect(parseCount.get(a)).toBe(1);

    const peek = await index.peekUsage([a, b], "h1");
    expect(peek.raw).toEqual([{ path: a, kind: "skill", token: "x:qa", invocations: 2, lastUsedMs: statSync(a).mtimeMs }]);
    expect(peek.pending).toBe(true);              // `b` is unindexed → a real sync would reparse it
    expect(parseCount.get(b) ?? 0).toBe(0);       // ...but peek parsed NOTHING
    expect(parseCount.get(a)).toBe(1);            // and did not re-parse `a`
  });

  it("reports pending:false once the index is caught up", async () => {
    const a = join(dir, "a.jsonl"); write(a, "a");
    const { parseFile } = makeParser();
    await index.syncUsage([a], "h1", parseFile);
    expect((await index.peekUsage([a], "h1")).pending).toBe(false);
  });

  it("reports pending:true when a hook-digest change would force a reparse", async () => {
    const a = join(dir, "a.jsonl"); write(a, "a");
    const { parseFile } = makeParser();
    await index.syncUsage([a], "h1", parseFile);
    expect((await index.peekUsage([a], "h1")).pending).toBe(false);
    expect((await index.peekUsage([a], "h2")).pending).toBe(true);   // digest moved → `a` is dirty
  });
});
