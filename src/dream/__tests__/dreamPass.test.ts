// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/__tests__/dreamPass.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dreamRoot } from "../dreamPass.js";
import { readQueue, readDiary } from "../store.js";

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [1], atMs: 5 }] };
const analyzePayload = {
  candidates: [], gaps: ["no CI"], degraded: false,
  signalSummary: { sessionsScanned: 3, spanDays: 2, notes: null },
  distilled: [{ name: "foo", description: "d", triggers: [], tools: [], mutating: false, body: "b",
    evidence: { sessions: 1, exampleSequence: [], root: "/p", provenance: prov }, status: "draft", confidence: "medium", origin: "llm" }],
  reflections: [{ kind: "recurring-decision", detail: "finish the migration", importance: "high", provenance: prov }],
};
const insightsPayload = {
  report: {
    totals: { sessions: 1, mostly: 1, partially: 0, not: 0 }, outcomes_summary: "", narrative: "",
    by_model: [], friction: [], publish_candidates: [{ sessionId: "sess-1", goal: "ship the thing", why: "clean success" }],
  },
  facets: [], degraded: false, signalSummary: { sessionsScanned: 1, spanDays: 1, notes: null },
};

describe("dreamRoot", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "dreampass-")); });

  const deps = (over = {}) => ({
    enabled: true, base, now: () => 42,
    analyze: async () => ({ payload: analyzePayload, cached: true, updatedAt: 1 }),
    insights: async () => ({ payload: insightsPayload, cached: true, updatedAt: 1 }),
    ...over,
  });

  it("returns 'hit' and writes nothing when disabled", async () => {
    expect(await dreamRoot("/p", deps({ enabled: false }))).toBe("hit");
    expect(readQueue(base)).toEqual([]);
  });

  it("enqueues skill + lesson (DEEP) + opportunity (REM) and writes a diary entry when enabled", async () => {
    expect(await dreamRoot("/p", deps())).toBe("warmed");
    const q = readQueue(base);
    expect(q.map((e) => e.kind).sort()).toEqual(["lesson", "opportunity", "skill"]);
    const opp = q.find((e) => e.kind === "opportunity");
    expect(opp?.key).toBe("opportunity:/p:sess-1");
    expect(opp?.phase).toBe("REM");
    const d = readDiary(base);
    expect(d[0].enqueued).toEqual({ skills: 1, lessons: 1, opportunities: 1 });
    expect(d[0].phasesLit).toEqual(["DEEP", "REM"]);
    expect(d[0].rootsProcessed).toEqual(["/p"]);
  });

  it("requests cache-only reads so the harvest never triggers a real pass", async () => {
    let seen: { cacheOnly?: boolean } | undefined;
    await dreamRoot("/p", deps({
      analyze: async (_root: string, o: { cacheOnly?: boolean }) => { seen = o; return { payload: analyzePayload, cached: true, updatedAt: 1 }; },
    }));
    expect(seen?.cacheOnly).toBe(true);
  });

  it("returns 'hit' on a second run (all keys already seen)", async () => {
    await dreamRoot("/p", deps());
    expect(await dreamRoot("/p", deps())).toBe("hit");
    expect(readQueue(base).length).toBe(3); // skill + lesson + opportunity, no duplicates
  });
});
