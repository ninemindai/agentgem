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

  it("dismiss removes from queued and blocks re-list", async () => {
    enqueueNew([lessonEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    await c.dismiss({ body: { key: "lesson:/p:l1:h" } });
    expect((await c.queue()).items.length).toBe(0);
  });
});
