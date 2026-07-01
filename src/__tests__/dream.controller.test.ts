// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/dream.controller.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamController } from "../dream.controller.js";
import { enqueueNew } from "../dream/store.js";
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

  it("dismiss removes from queued and blocks re-list", async () => {
    enqueueNew([lessonEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await c.dismiss({ body: { key: "lesson:/p:l1:h" } });
    expect((await c.queue()).items.length).toBe(0);
  });

  it("rejects a draft whose name would escape the distilled path", async () => {
    const bad = { ...skillEntry(), key: "skill:/p:evil:h", name: "../evil" };
    enqueueNew([bad], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await expect(c.accept({ body: { key: "skill:/p:evil:h" } })).rejects.toThrow();
  });
});
