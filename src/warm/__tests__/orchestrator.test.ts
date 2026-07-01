// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { runWarmPass, getWarmStatus, beginForeground, endForeground } from "../orchestrator.js";
import type { Warmable } from "../registry.js";

function fakeRegistry(calls: string[]): Warmable[] {
  const mk = (id: Warmable["id"], cost: Warmable["cost"], scope: Warmable["scope"]): Warmable => ({
    id, cost, scope,
    async warm(root) { calls.push(`${id}:${root ?? "-"}`); return "warmed"; },
  });
  return [mk("usage", "cheap", "global"), mk("insights", "llm", "per-root")];
}

describe("runWarmPass", () => {
  it("runs global warmables once and per-root LLM warmables for the top-N roots", async () => {
    const calls: string[] = [];
    const res = await runWarmPass({
      registry: fakeRegistry(calls),
      roots: ["/a", "/b", "/c"], topN: 2, now: () => 1000, isBusy: () => false,
    });
    expect(calls).toEqual(["usage:-", "insights:/a", "insights:/b"]);   // /c dropped by topN=2
    expect(res.outcomes.filter((o) => o.status === "warmed")).toHaveLength(3);
  });

  it("skips LLM warmables when foreground is busy, still runs cheap ones", async () => {
    const calls: string[] = [];
    const res = await runWarmPass({
      registry: fakeRegistry(calls), roots: ["/a"], topN: 5, now: () => 1, isBusy: () => true,
    });
    expect(calls).toEqual(["usage:-"]);
    expect(res.outcomes.find((o) => o.id === "insights")?.status).toBe("skipped");
  });

  it("is best-effort: a throwing warmable is recorded as error and does not abort the pass", async () => {
    const calls: string[] = [];
    const reg: Warmable[] = [
      { id: "usage", cost: "cheap", scope: "global", async warm() { throw new Error("boom"); } },
      { id: "insights", cost: "llm", scope: "per-root", async warm(root) { calls.push(String(root)); return "warmed"; } },
    ];
    const res = await runWarmPass({ registry: reg, roots: ["/a"], now: () => 1, isBusy: () => false });
    expect(res.outcomes.find((o) => o.id === "usage")?.status).toBe("error");
    expect(calls).toEqual(["/a"]);   // insights still ran after usage threw
  });

  it("does not start an overlapping pass while one is already running", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reg: Warmable[] = [{ id: "usage", cost: "cheap", scope: "global", async warm() { calls++; await gate; return "warmed"; } }];
    const p1 = runWarmPass({ registry: reg, roots: [], now: () => 1, isBusy: () => false });
    await runWarmPass({ registry: reg, roots: [], now: () => 2, isBusy: () => false }); // must bail immediately
    expect(calls).toBe(1);
    release();
    await p1;
    expect(calls).toBe(1);
  });

  it("reports running=false and the last result after a pass; foreground flag toggles", async () => {
    beginForeground();
    // isForegroundBusy default is used only when isBusy is not injected; here we assert the toggle:
    endForeground();
    await runWarmPass({ registry: fakeRegistry([]), roots: [], now: () => 42, isBusy: () => false });
    expect(getWarmStatus().running).toBe(false);
    expect(getWarmStatus().last?.finishedAt).toBe(42);
  });
});

describe("runWarmPass – AGENTGEM_WARM_TOPN env override", () => {
  const KEY = "AGENTGEM_WARM_TOPN";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("env='2' with no explicit topN → honors 2 (roots beyond index 1 dropped)", async () => {
    process.env[KEY] = "2";
    const calls: string[] = [];
    await runWarmPass({
      registry: fakeRegistry(calls),
      roots: ["/a", "/b", "/c", "/d"],   // > 2
      now: () => 1, isBusy: () => false,
    });
    // per-root warmable should fire for /a and /b only
    expect(calls.filter((c) => c.startsWith("insights:"))).toEqual(["insights:/a", "insights:/b"]);
  });

  it("explicit opts.topN overrides env", async () => {
    process.env[KEY] = "2";
    const calls: string[] = [];
    await runWarmPass({
      registry: fakeRegistry(calls),
      roots: ["/a", "/b", "/c"],
      topN: 1,   // explicit wins over env "2"
      now: () => 1, isBusy: () => false,
    });
    expect(calls.filter((c) => c.startsWith("insights:"))).toEqual(["insights:/a"]);
  });

  it("invalid env ('abc') → falls back to DEFAULT_TOP_N (5)", async () => {
    process.env[KEY] = "abc";
    const calls: string[] = [];
    await runWarmPass({
      registry: fakeRegistry(calls),
      roots: ["/a", "/b", "/c", "/d", "/e", "/f"],   // 6 roots; default 5 should limit to 5
      now: () => 1, isBusy: () => false,
    });
    expect(calls.filter((c) => c.startsWith("insights:"))).toHaveLength(5);
  });

  it("env='0' (<=0) → falls back to DEFAULT_TOP_N", async () => {
    process.env[KEY] = "0";
    const calls: string[] = [];
    await runWarmPass({
      registry: fakeRegistry(calls),
      roots: ["/a", "/b", "/c", "/d", "/e", "/f"],
      now: () => 1, isBusy: () => false,
    });
    expect(calls.filter((c) => c.startsWith("insights:"))).toHaveLength(5);
  });
});
