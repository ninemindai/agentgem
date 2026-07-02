// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/__tests__/store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueue, enqueueNew, setStatus, readDiary, appendDiary, promotedCount } from "../store.js";
import type { DreamQueueEntry, DreamDiaryEntry } from "../types.js";

function entry(over: Partial<DreamQueueEntry> = {}): DreamQueueEntry {
  return {
    key: "skill:/p:foo:abc", kind: "skill", root: "/p", name: "foo",
    summary: "does foo", confidence: "high", phase: "DEEP",
    draft: { name: "foo" } as unknown as DreamQueueEntry["draft"],
    status: "queued", firstSeenMs: 1, ...over,
  };
}

describe("dream store", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "dream-")); });

  it("enqueues new keys and dedups against existing", () => {
    expect(enqueueNew([entry()], base).length).toBe(1);
    const added = enqueueNew([entry(), entry({ key: "skill:/p:bar:xyz", name: "bar" })], base);
    expect(added.map((e) => e.name)).toEqual(["bar"]); // foo skipped
    expect(readQueue(base).length).toBe(2);
  });

  it("dedups against accepted/dismissed too", () => {
    enqueueNew([entry()], base);
    setStatus("skill:/p:foo:abc", "dismissed", 5, base);
    expect(enqueueNew([entry()], base).length).toBe(0); // never resurfaces
  });

  it("setStatus updates status + reviewedMs and counts promoted", () => {
    enqueueNew([entry(), entry({ key: "k2", name: "bar" })], base);
    expect(setStatus("k2", "accepted", 9, base)?.reviewedMs).toBe(9);
    expect(promotedCount(base)).toBe(1);
  });

  it("promotedCount excludes accepted opportunities (they write no file)", () => {
    enqueueNew([entry(), entry({ key: "opp", kind: "opportunity", name: "sess-1" })], base);
    setStatus("skill:/p:foo:abc", "accepted", 1, base); // a real distilled draft
    setStatus("opp", "accepted", 1, base);              // an acknowledged opportunity
    expect(promotedCount(base)).toBe(1); // only the skill counts
  });

  it("appendDiary keeps newest 100", () => {
    for (let i = 0; i < 105; i++) {
      appendDiary({ atMs: i, passId: i, rootsProcessed: [], phasesLit: [], enqueued: { skills: 0, lessons: 0 }, degraded: false } as DreamDiaryEntry, base);
    }
    const d = readDiary(base);
    expect(d.length).toBe(100);
    expect(d[0].atMs).toBe(104); // newest first
  });

  it("readQueue returns [] when nothing written", () => {
    expect(readQueue(base)).toEqual([]);
  });

  it("signals failure (no false success) when the sidecar can't be written", () => {
    // Put a FILE where the `.agentgem` dir should be, so mkdir of `.agentgem/dream` fails (ENOTDIR).
    writeFileSync(join(base, ".agentgem"), "x", "utf8");
    expect(enqueueNew([entry()], base)).toEqual([]); // nothing persisted → return [], not the "added" set
    expect(readQueue(base)).toEqual([]); // reads stay safe too
  });
});
