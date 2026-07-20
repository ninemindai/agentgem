// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from "vitest";

// Isolate toggle state in-memory instead of touching the real agentgemHome() config file /
// AGENTGEM_BENCHMARK_CONTRIBUTE env var (mirrors how config.test.ts isolates via a temp base).
const state = { enabled: false };
vi.mock("../benchmark/config.js", () => ({
  benchmarkContribute: vi.fn(() => state.enabled),
  setBenchmarkContribute: vi.fn((enabled: boolean) => { state.enabled = enabled; }),
}));
// The "on" path enumerates + scans + posts over the network via defaultDeps(); never let this
// test call the real thing — mock the core contribution flow entirely.
vi.mock("../benchmark/contributeCore.js", () => ({
  contribute: vi.fn(async () => ({ enabled: true, results: [{ gem: "demo", status: "ingested" }] })),
}));

import { BenchmarkProxyController } from "../benchmark.proxy.controller.js";
import { benchmarkContribute, setBenchmarkContribute } from "../benchmark/config.js";
import { contribute as mockRunContribute } from "../benchmark/contributeCore.js";

describe("BenchmarkProxyController contribute + consent setting", () => {
  beforeEach(() => {
    state.enabled = false;
    vi.mocked(benchmarkContribute).mockClear();
    vi.mocked(setBenchmarkContribute).mockClear();
    vi.mocked(mockRunContribute).mockClear();
  });

  it("POST /contribute rejects with 409 when the toggle is off", async () => {
    const c = new BenchmarkProxyController();
    await expect(c.contribute()).rejects.toMatchObject({ statusCode: 409, code: "contribute_disabled" });
    expect(mockRunContribute).not.toHaveBeenCalled();
  });

  it("POST /contribute-setting then GET round-trips the toggle", async () => {
    const c = new BenchmarkProxyController();
    expect(await c.getContributeSetting()).toEqual({ enabled: false });

    const setResult = await c.setContributeSetting({ body: { enabled: true } });
    expect(setResult).toEqual({ enabled: true });
    expect(setBenchmarkContribute).toHaveBeenCalledWith(true);

    expect(await c.getContributeSetting()).toEqual({ enabled: true });
  });

  it("POST /contribute runs the contribution and returns results when the toggle is on", async () => {
    state.enabled = true;
    const c = new BenchmarkProxyController();
    const result = await c.contribute();
    expect(result).toEqual({ results: [{ gem: "demo", status: "ingested" }] });
    expect(mockRunContribute).toHaveBeenCalledTimes(1);
  });
});
