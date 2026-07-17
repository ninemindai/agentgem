// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { ScorecardController, setScorecardDepsForTests, type ScorecardStreamDeps } from "../scorecard.stream.controller.js";

afterEach(() => setScorecardDepsForTests(null));

// Each project gets its own unique key so breadth climbs 1→2→3 across calls.
// provenance is required — scoreProject reads it (occurrences → lastSeenMs).
const mkLoad = (key = "k") => ({
  signal: {} as never,
  candidates: [{ key, priorConfidence: "high" as const, sessions: 3, skeleton: { name: key, tools: ["WebFetch"] }, provenance: { occurrences: [] } }],
  reflections: [],
});
const baseDeps = (o: Partial<ScorecardStreamDeps>): ScorecardStreamDeps => ({
  discover: () => [],
  loadProject: () => mkLoad() as never,
  transcriptsFor: () => [],
  bucketTranscripts: () => new Map(),
  readCacheEntry: () => null,
  readLatestCache: () => null,
  writeCache: vi.fn(),
  ...o,
});

type Ev = { type: string; [k: string]: unknown };
// Drive the streamOf generator, collecting into `out` (passed in so deps can
// snapshot what's been emitted so far — the timing tests need that).
async function drive(query: Record<string, string>, out: Ev[] = []): Promise<Ev[]> {
  for await (const e of new ScorecardController().stream({ query } as never)) out.push(e as Ev);
  return out;
}

describe("ScorecardController.stream (streamOf route)", () => {
  it("emits start, climbing progress per project, then done", async () => {
    let callCount = 0;
    setScorecardDepsForTests(baseDeps({ loadProject: () => mkLoad(`k${callCount++}`) as never }));

    const ev = await drive({ projects: JSON.stringify(["/r/a", "/r/b", "/r/c"]) });

    expect(ev[0]).toMatchObject({ type: "start", total: 3 });
    const progress = ev.filter((e) => e.type === "progress");
    expect(progress).toHaveLength(3);
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3]);
    expect(progress.map((p) => (p.partial as { breadth: number }).breadth)).toEqual([1, 2, 3]); // climbs
    const done = ev.find((e) => e.type === "done");
    expect((done?.scorecard as { breadth: number }).breadth).toBe(3);
  });

  it("emits start BEFORE bucketing transcripts (no dead-silence while the bucket read runs)", async () => {
    const out: Ev[] = [];
    let typesAtBucket: string[] = [];
    setScorecardDepsForTests(baseDeps({ bucketTranscripts: () => { typesAtBucket = out.map((e) => e.type); return new Map(); } }));

    await drive({ projects: JSON.stringify(["/r/a"]) }, out);

    expect(typesAtBucket).toContain("start"); // start was emitted before the bucket read ran
  });

  it("emits `stale` before the blocking bucket read (SWR paints first)", async () => {
    const STALE_SC = { breadth: 5, battleTested: 2, portable: 1, gaps: [], projects: [], generatedAtMs: 0, degraded: false };
    const out: Ev[] = [];
    let typesAtBucket: string[] = [];
    setScorecardDepsForTests(baseDeps({
      readLatestCache: () => ({ result: STALE_SC, ts: 1 }),
      bucketTranscripts: () => { typesAtBucket = out.map((e) => e.type); return new Map(); },
    }));

    await drive({ projects: JSON.stringify(["/r/a"]) }, out);

    expect(typesAtBucket[0]).toBe("stale"); // stale painted before the seconds-long bucket read
  });

  it("stale-while-revalidate: emits `stale` (last-good) before any progress, then a fresh `done` supersedes it", async () => {
    const STALE_SC = { breadth: 5, battleTested: 2, portable: 1, gaps: [], projects: [], generatedAtMs: 0, degraded: false };
    const loadProject = vi.fn(() => mkLoad("fresh") as never);
    setScorecardDepsForTests(baseDeps({ loadProject, readLatestCache: () => ({ result: STALE_SC, ts: 777 }) }));

    const ev = await drive({ projects: JSON.stringify(["/r/a"]) });

    const staleIdx = ev.findIndex((e) => e.type === "stale");
    const firstProgressIdx = ev.findIndex((e) => e.type === "progress");
    expect(staleIdx).toBeGreaterThan(-1);
    expect(ev[staleIdx]).toMatchObject({ scorecard: { breadth: 5 }, updatedAt: 777 });
    expect(staleIdx).toBeLessThan(firstProgressIdx); // painted BEFORE the rescan begins
    expect(loadProject).toHaveBeenCalled();
    const done = ev.find((e) => e.type === "done");
    expect(done?.cached).toBe(false);
    expect((done?.scorecard as { breadth: number }).breadth).toBe(1);
  });

  it("emits done immediately on cache hit (no progress)", async () => {
    const loadProject = vi.fn(() => mkLoad() as never);
    const CACHED_SC = { breadth: 9, battleTested: 0, portable: 0, gaps: [], projects: [], generatedAtMs: 0, degraded: false };
    setScorecardDepsForTests(baseDeps({ loadProject, readCacheEntry: () => ({ result: CACHED_SC, ts: 11111 }) }));

    const ev = await drive({ projects: JSON.stringify(["/r/a"]) });

    expect(ev.some((e) => e.type === "progress")).toBe(false);
    expect(ev.find((e) => e.type === "done")).toMatchObject({ cached: true, scorecard: { breadth: 9 }, updatedAt: 11111 });
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("bypasses the cache and re-scans when refresh=true", async () => {
    const loadProject = vi.fn(() => mkLoad() as never);
    const CACHED_SC = { breadth: 9, battleTested: 0, portable: 0, gaps: [], projects: [], generatedAtMs: 0, degraded: false };
    setScorecardDepsForTests(baseDeps({ loadProject, readCacheEntry: () => ({ result: CACHED_SC, ts: 22222 }) }));

    const ev = await drive({ projects: JSON.stringify(["/r/a"]), refresh: "true" });

    expect(ev.some((e) => e.type === "progress")).toBe(true);
    expect(loadProject).toHaveBeenCalled();
  });
});
