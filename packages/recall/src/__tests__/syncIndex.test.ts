// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex } from "../recallIndex.js";
import { syncRecallIndex, stampOf } from "../syncIndex.js";
import type { SessionStat, TranscriptView } from "@agentgem/insight";

let dir: string; let idx: RecallIndex;
const stat = (id: string, over: Partial<SessionStat> = {}): SessionStat =>
  ({ agent: "claude", sessionId: id, project: "agentgem", cwd: null, model: null, gitBranch: "main",
     startMs: 1000, endMs: 2000, msgs: 4, tokensIn: 0, tokensOut: 0, tokensCache: 0, ...over });
const viewFor = (id: string, text: string): TranscriptView =>
  ({ sessionId: id, agent: "claude", model: null, project: "agentgem", startMs: 1000, endMs: 2000,
     turns: [{ index: 0, role: "user", spans: [{ kind: "message", role: "user", text }] }] } as unknown as TranscriptView);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recall-sync-")); idx = new RecallIndex(join(dir, "i.db")); });
afterEach(() => { idx.close(); rmSync(dir, { recursive: true, force: true }); });

describe("syncRecallIndex", () => {
  it("indexes sessions and makes their content searchable", async () => {
    const deps = { loadTranscript: async (id: string) => viewFor(id, "prod migration " + id) };
    const r = await syncRecallIndex(idx, [stat("s1"), stat("s2")], deps);
    expect(r.indexed).toBe(2);
    expect(idx.search("migration", {}, 10).map((h) => h.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("skips unchanged sessions on a second sync (same stamp)", async () => {
    let loads = 0;
    const deps = { loadTranscript: async (id: string) => { loads++; return viewFor(id, "content"); } };
    await syncRecallIndex(idx, [stat("s1")], deps);
    const r2 = await syncRecallIndex(idx, [stat("s1")], deps);
    expect(loads).toBe(1);            // not re-loaded
    expect(r2.indexed).toBe(0);
  });

  it("re-indexes a session whose stamp changed (msgs grew)", async () => {
    const deps = { loadTranscript: async (id: string) => viewFor(id, "grew") };
    await syncRecallIndex(idx, [stat("s1", { msgs: 4 })], deps);
    const r2 = await syncRecallIndex(idx, [stat("s1", { msgs: 9 })], deps);
    expect(r2.indexed).toBe(1);
  });

  it("prunes vanished sessions and counts unparseable ones as skipped", async () => {
    await syncRecallIndex(idx, [stat("s1")], { loadTranscript: async (id: string) => viewFor(id, "keep") });
    const r = await syncRecallIndex(idx, [stat("s2")], { loadTranscript: async () => null });
    expect(r.skipped).toBe(1);        // s2 unparseable
    expect(r.removed).toBe(1);        // s1 gone
    expect(idx.indexedSessions().size).toBe(0);
  });
});

describe("stampOf", () => {
  it("combines endMs and msgs", () => { expect(stampOf(stat("s", { endMs: 7, msgs: 3 }))).toBe("7:3"); });
});
