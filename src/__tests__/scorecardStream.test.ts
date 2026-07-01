import { describe, it, expect, vi } from "vitest";
import { streamScorecard, type ScorecardStreamDeps } from "../scorecardStream.js";

function fakeRes() {
  const chunks: string[] = [];
  return {
    chunks,
    writeHead: vi.fn(),
    write: (c: string) => { chunks.push(c); },
    end: vi.fn(),
  };
}

function events(chunks: string[]) {
  return chunks
    .join("")
    .split("\n\n")
    .filter(Boolean)
    .map((f) => {
      const ev = /event: (.*)/.exec(f)?.[1];
      const dt = /data: (.*)/.exec(f)?.[1];
      return { event: ev, data: dt ? JSON.parse(dt) : null };
    });
}

// Each project gets its own unique key so breadth climbs 1→2→3 across calls.
const mkLoad = (key = "k") => ({
  signal: {} as never,
  candidates: [{ key, priorConfidence: "high" as const, sessions: 3, skeleton: { name: key, tools: ["WebFetch"] } }],
  reflections: [],
});

describe("streamScorecard", () => {
  it("emits start, climbing progress per project, then done", async () => {
    let callCount = 0;
    const deps: ScorecardStreamDeps = {
      discover: () => [],
      loadProject: () => mkLoad(`k${callCount++}`) as never,
      transcriptsFor: () => [],
      bucketTranscripts: () => new Map(),
      readCacheEntry: () => null,
      writeCache: vi.fn(),
    };
    const res = fakeRes();
    await streamScorecard(
      { query: { projects: JSON.stringify(["/r/a", "/r/b", "/r/c"]) } },
      res as never,
      deps,
    );
    const ev = events(res.chunks);
    expect(ev[0]).toMatchObject({ event: "start", data: { total: 3 } });
    const progress = ev.filter((e) => e.event === "progress");
    expect(progress).toHaveLength(3);
    expect(progress.map((p) => p.data.done)).toEqual([1, 2, 3]);
    expect(progress.map((p) => p.data.partial.breadth)).toEqual([1, 2, 3]); // climbs
    const done = ev.find((e) => e.event === "done");
    expect(done?.data.scorecard.breadth).toBe(3);
    expect(res.end).toHaveBeenCalled();
  });

  it("emits done immediately on cache hit (no progress)", async () => {
    const loadProject = vi.fn(() => mkLoad() as never);
    const CACHED_SC = { breadth: 9, battleTested: 0, portable: 0, gaps: [], projects: [], generatedAtMs: 0, degraded: false };
    const deps: ScorecardStreamDeps = {
      discover: () => [],
      loadProject,
      transcriptsFor: () => [],
      bucketTranscripts: () => new Map(),
      readCacheEntry: () => ({ result: CACHED_SC, ts: 11111 }),
      writeCache: vi.fn(),
    };
    const res = fakeRes();
    await streamScorecard(
      { query: { projects: JSON.stringify(["/r/a"]) } },
      res as never,
      deps,
    );
    const ev = events(res.chunks);
    expect(ev.some((e) => e.event === "progress")).toBe(false);
    expect(ev.find((e) => e.event === "done")?.data).toMatchObject({ cached: true, scorecard: { breadth: 9 }, updatedAt: 11111 });
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("bypasses the cache and re-scans when refresh=true", async () => {
    const loadProject = vi.fn(() => mkLoad() as never);
    const CACHED_SC = { breadth: 9, battleTested: 0, portable: 0, gaps: [], projects: [], generatedAtMs: 0, degraded: false };
    const deps: ScorecardStreamDeps = {
      discover: () => [],
      loadProject,
      transcriptsFor: () => [],
      bucketTranscripts: () => new Map(),
      readCacheEntry: () => ({ result: CACHED_SC, ts: 22222 }),
      writeCache: vi.fn(),
    };
    const res = fakeRes();
    await streamScorecard(
      { query: { projects: JSON.stringify(["/r/a"]), refresh: "true" } },
      res as never,
      deps,
    );
    const ev = events(res.chunks);
    // refresh ignores the cached result: it actually scans (progress) and loads the project
    expect(ev.some((e) => e.event === "progress")).toBe(true);
    expect(loadProject).toHaveBeenCalled();
  });
});
