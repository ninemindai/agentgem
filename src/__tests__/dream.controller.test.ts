// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/dream.controller.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamController } from "../dream.controller.js";
import { enqueueNew, appendDiary } from "../dream/store.js";
import { appendVerification } from "@agentgem/run";
import type { DreamQueueEntry } from "../dream/types.js";

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [1], atMs: 5 }] };
function lessonEntry(): DreamQueueEntry {
  return { key: "lesson:/p:l1:h", kind: "lesson", root: "/p", name: "l1", summary: "use pnpm",
    importance: "high", phase: "DEEP",
    draft: { kind: "recurring-decision", detail: "use pnpm", importance: "high", provenance: prov } as DreamQueueEntry["draft"],
    status: "queued", firstSeenMs: 1 };
}
function skillEntry(): DreamQueueEntry {
  return { key: "skill:/p:run-migrations:h", kind: "skill", root: "/p", name: "run-migrations",
    summary: "apply db migrations", confidence: "high", phase: "DEEP",
    draft: { name: "run-migrations", description: "apply db migrations", triggers: [], tools: [], mutating: true,
      body: "…", evidence: { sessions: 1, exampleSequence: [], root: "/p", provenance: prov },
      status: "draft", confidence: "high", origin: "llm" } as DreamQueueEntry["draft"],
    status: "queued", firstSeenMs: 1 };
}
function opportunityEntry(): DreamQueueEntry {
  return { key: "opportunity:/p:sess-1", kind: "opportunity", root: "/p", name: "sess-1", summary: "ship it",
    phase: "REM", draft: { sessionId: "sess-1", goal: "ship it", why: "clean success" } as DreamQueueEntry["draft"],
    status: "queued", firstSeenMs: 1 };
}

describe("DreamController", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "dreamctl-")); });

  it("lists queued items and accepts a lesson (writes a distilled draft)", async () => {
    enqueueNew([lessonEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base; // test seam: override home
    expect((await c.queue()).items.length).toBe(1);
    const res = await c.accept({ body: { key: "lesson:/p:l1:h" } });
    expect(res.ok).toBe(true);
    expect(res.path).toContain(join(".agentgem", "distilled", "lessons", "l1.md"));
  });

  it("accepts a skill (writes a distilled SKILL.md)", async () => {
    enqueueNew([skillEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const res = await c.accept({ body: { key: "skill:/p:run-migrations:h" } });
    expect(res.ok).toBe(true);
    expect(res.path).toContain(join(".agentgem", "distilled", "run-migrations", "SKILL.md"));
  });

  it("accepts an opportunity without writing a file (empty path, leaves queue)", async () => {
    enqueueNew([opportunityEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const res = await c.accept({ body: { key: "opportunity:/p:sess-1" } });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(""); // no distilled file for opportunities
    expect((await c.queue()).items.length).toBe(0);
  });

  it("dismiss removes from queued and blocks re-list", async () => {
    enqueueNew([lessonEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await c.dismiss({ body: { key: "lesson:/p:l1:h" } });
    expect((await c.queue()).items.length).toBe(0);
  });

  it("rejects a skill whose DRAFT name would escape the distilled path", async () => {
    // The path segment comes from draft.name, not entry.name — a corrupted queue.json could
    // pair a safe entry.name with an unsafe draft.name. The guard must catch the draft name.
    const s = skillEntry();
    (s.draft as { name: string }).name = "../evil"; // entry.name stays "run-migrations" (safe)
    s.key = "skill:/p:evil:h";
    enqueueNew([s], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await expect(c.accept({ body: { key: "skill:/p:evil:h" } })).rejects.toThrow();
  });

  it("rejects accepting a lesson whose draft is an unresolved-task (not shareable)", async () => {
    const e: DreamQueueEntry = { key: "lesson:/p:todo:h", kind: "lesson", root: "/p", name: "todo",
      summary: "finish it", importance: "high", phase: "DEEP",
      draft: { kind: "unresolved-task", detail: "finish it", importance: "high", provenance: prov } as DreamQueueEntry["draft"],
      status: "queued", firstSeenMs: 1 };
    enqueueNew([e], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await expect(c.accept({ body: { key: "lesson:/p:todo:h" } })).rejects.toThrow();
  });

  it("rejects accepting a guardrail (Task 5 implements the real write)", async () => {
    const e: DreamQueueEntry = { key: "guardrail:/p:repeated-tool-error:h", kind: "guardrail", root: "/p",
      name: "repeated-tool-error-h", summary: "Bash errored 2x", confidence: "medium", phase: "DEEP",
      draft: { detectorId: "repeated-tool-error", tool: "Bash", detail: "Bash errored 2x", confidence: "medium",
        occurrences: 2, provenance: prov } as DreamQueueEntry["draft"],
      status: "queued", firstSeenMs: 1 };
    enqueueNew([e], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await expect(c.accept({ body: { key: "guardrail:/p:repeated-tool-error:h" } })).rejects.toThrow(/Task 5/);
    // Never silently routed through the lesson branch — status must remain queued.
    expect((await c.queue()).items[0].status).toBe("queued");
  });

  it("returns diary entries newest-first", async () => {
    appendDiary({ atMs: 1, passId: 1, rootsProcessed: ["/p"], phasesLit: ["DEEP"], enqueued: { skills: 2, lessons: 1 }, degraded: false }, base);
    appendDiary({ atMs: 2, passId: 2, rootsProcessed: ["/q"], phasesLit: ["LIGHT"], enqueued: { skills: 0, lessons: 0 }, degraded: true }, base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const r = await c.diary();
    expect(r.entries.length).toBe(2);
    expect(r.entries[0].passId).toBe(2); // appendDiary prepends → newest first
    expect(r.entries[0].degraded).toBe(true);
  });

  it("POST /dream/learn distills a session into the queue and returns counts", async () => {
    // Claude-home fixture with one session for a project.
    const home = mkdtempSync(join(tmpdir(), "dreamlearn-"));
    const claudeDir = join(home, ".claude");
    const enc = join(claudeDir, "projects", "enc-a");
    mkdirSync(enc, { recursive: true });
    writeFileSync(join(enc, "s1.jsonl"), JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd: "/Users/me/work/app" }) + "\n");
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    try {
      const r = await c.learn({ body: { root: "/Users/me/work/app", dir: claudeDir } });
      // Synthetic near-empty transcript: the real pipeline finds nothing — that is success.
      expect(r.session).toBe("s1.jsonl");
      expect(r.enqueued).toBe(0);
      expect(r.entries).toEqual([]);
      expect(typeof r.degraded).toBe("boolean");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("POST /dream/learn rejects an unknown session ref", async () => {
    const home = mkdtempSync(join(tmpdir(), "dreamlearn-"));
    const claudeDir = join(home, ".claude");
    mkdirSync(join(claudeDir, "projects"), { recursive: true });
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    try {
      await expect(c.learn({ body: { root: "/Users/me/work/app", dir: claudeDir, session: "nope" } }))
        .rejects.toThrow(/no session/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("GET /journey merges queue and ledger events newest-first", async () => {
    enqueueNew([lessonEntry()], base);           // firstSeenMs: 1
    appendVerification({
      gemName: "g", agent: "claude", contractApplied: true,
      run: { ok: true, toolCalls: 1 },
      verification: { passed: true, checks: [] },
    }, base);                                    // ts: now (newest)
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const r = await c.journey({ query: {} });
    expect(r.events.map((e) => e.kind)).toEqual(["verified", "lesson"]);
    expect(r.truncated).toBe(false);
  });

  it("GET /journey filters by kind", async () => {
    enqueueNew([lessonEntry(), skillEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const r = await c.journey({ query: { kind: "skill" } });
    expect(r.events.map((e) => e.kind)).toEqual(["skill"]);
  });
});
