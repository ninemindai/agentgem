// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";

vi.mock("../gem/benchmarkClient.js", () => ({
  benchmarks: vi.fn(async () => [{ model: "opus" }]),
  effectiveness: vi.fn(async () => [{ gemName: "g" }]),
}));

import { BenchmarkProxyController } from "../benchmark.proxy.controller.js";
import { effectiveness as effClient } from "../gem/benchmarkClient.js";

describe("BenchmarkProxyController", () => {
  it("delegates benchmarks to the client", async () => {
    expect(await new BenchmarkProxyController().benchmarks()).toEqual([{ model: "opus" }]);
  });
  it("forwards effectiveness query to the client", async () => {
    const c = new BenchmarkProxyController();
    await c.effectiveness({ query: { sort: "score", minConfidence: 0.3 } });
    expect(effClient).toHaveBeenCalledWith(expect.objectContaining({ sort: "score", minConfidence: 0.3 }));
  });
});
