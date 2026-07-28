// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The on-disk score cache: it must be TRANSPARENT (same inputs, byte-identical output,
// cached or not), keyed so a changed transcript can never serve a stale row, and unable to
// break a scan when the disk misbehaves.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGemitInputs } from "../gemit/collect.js";
import { readScoreCache, scoreCacheKey, writeScoreCache } from "../gemit/scoreCache.js";
import type { SessionStat } from "@agentgem/insight";

const NOW = Date.UTC(2026, 6, 28, 12);

// AGENTGEM_HOME redirects agentgemHome(), so the cache lands in a temp dir and the
// developer's real ~/.agentgem is never read or written by these tests.
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gemit-cache-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENTGEM_HOME;
  else process.env.AGENTGEM_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function stat(i: number, over: Partial<SessionStat> = {}): SessionStat {
  return {
    agent: "claude", sessionId: `s${i}`, project: "p", cwd: null, model: null, gitBranch: null,
    startMs: NOW - 3600_000, endMs: NOW - i * 60_000, msgs: 40,
    tokensIn: 100, tokensOut: 500, tokensCache: 0,
    skills: { alpha: 1 }, subagents: { Explore: 1 },
  } as SessionStat as SessionStat & typeof over;
}

/** Counts how many sessions actually did the expensive derivation. */
function deps(stats: SessionStat[], calls: string[], cache?: boolean) {
  return {
    scan: async () => stats,
    summarize: async (id: string) => {
      calls.push(id);
      return { process: { score: 80, label: "disciplined" }, findings: [{ id: "f", title: "F", count: 1 }],
        events: { verifications: 2 } } as never;
    },
    hygieneFor: async () => ({ score: 90, verdict: "bounded" as const, findings: [] }),
    cache: cache ?? true,
  };
}

describe("gemit score cache", () => {
  it("is transparent: a cached run returns exactly what an uncached run computed", async () => {
    const stats = [stat(1), stat(2), stat(3)];

    const cold: string[] = [];
    const first = await collectGemitInputs(undefined, NOW, deps(stats, cold));
    expect(cold).toHaveLength(3); // nothing cached yet

    const warm: string[] = [];
    const second = await collectGemitInputs(undefined, NOW, deps(stats, warm));
    expect(warm).toEqual([]); // every session served from disk

    // The whole point: identical output, not merely equivalent.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("recomputes only the sessions whose transcript moved", async () => {
    const stats = [stat(1), stat(2), stat(3)];
    await collectGemitInputs(undefined, NOW, deps(stats, []));

    // s2 gained a message: endMs and msgs move, so its key moves with it.
    const grown = [stats[0], { ...stats[1], msgs: 41, endMs: stats[1].endMs + 1000 }, stats[2]];
    const calls: string[] = [];
    await collectGemitInputs(undefined, NOW, deps(grown, calls));
    expect(calls).toEqual(["s2"]);
  });

  it("keys on identity AND the counters, so a changed session cannot hit a stale row", () => {
    const a = stat(1);
    expect(scoreCacheKey(a)).toBe(scoreCacheKey({ ...a }));
    for (const field of ["endMs", "msgs", "tokensIn", "tokensOut", "tokensCache"] as const) {
      expect(scoreCacheKey({ ...a, [field]: a[field] + 1 })).not.toBe(scoreCacheKey(a));
    }
    expect(scoreCacheKey({ ...a, sessionId: "other" })).not.toBe(scoreCacheKey(a));
    expect(scoreCacheKey({ ...a, agent: "codex" })).not.toBe(scoreCacheKey(a));
  });

  // A custom --dir is the alternate-home path: it must neither read the real cache nor
  // write into it, or a test run would poison the operator's scores.
  it("neither reads nor writes the cache for a custom dir", async () => {
    const stats = [stat(1)];
    await collectGemitInputs(undefined, NOW, deps(stats, []));   // populate
    const calls: string[] = [];
    await collectGemitInputs("/somewhere/else", NOW, deps(stats, calls));
    expect(calls).toEqual(["s1"]);                                // recomputed, cache ignored
  });

  it("is off unless opted in", async () => {
    const stats = [stat(1)];
    await collectGemitInputs(undefined, NOW, deps(stats, []));
    const calls: string[] = [];
    await collectGemitInputs(undefined, NOW, deps(stats, calls, false));
    expect(calls).toEqual(["s1"]);
  });

  // Failing to use a cache must never fail a scan — it is an optimisation, not a dependency.
  it("survives a corrupt cache file by recomputing", async () => {
    mkdirSync(join(home, ".agentgem", "cache"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "cache", "gemit-scores.json"), "{not json");
    expect((await readScoreCache()).size).toBe(0);

    const calls: string[] = [];
    const out = await collectGemitInputs(undefined, NOW, deps([stat(1)], calls));
    expect(calls).toEqual(["s1"]);
    expect(out.scored).toHaveLength(1);
  });

  it("evicts oldest-first so a long-lived install stays bounded", async () => {
    const entries = new Map(Array.from({ length: 1200 }, (_, i) => [
      `k${i}`, { endMs: i, score: { hygieneScore: 1, hygieneVerdict: null, processScore: null,
        processLabel: null, findings: [], verifications: null } },
    ] as const));
    await writeScoreCache(entries as never);
    const back = await readScoreCache();
    expect(back.size).toBe(1000);
    expect(back.has("k1199")).toBe(true);  // newest kept
    expect(back.has("k0")).toBe(false);    // oldest evicted
  });
});
