import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkContribute, setBenchmarkContribute } from "@agentgem/app/benchmark/config";

describe("benchmark config", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "benchmarkcfg-")); delete process.env.AGENTGEM_BENCHMARK_CONTRIBUTE; });
  afterEach(() => { delete process.env.AGENTGEM_BENCHMARK_CONTRIBUTE; });

  it("defaults to false", () => { expect(benchmarkContribute(base)).toBe(false); });
  it("env enables", () => { process.env.AGENTGEM_BENCHMARK_CONTRIBUTE = "1"; expect(benchmarkContribute(base)).toBe(true); });
  it("config file overrides + round-trips", () => {
    setBenchmarkContribute(true, base);
    expect(benchmarkContribute(base)).toBe(true);
    setBenchmarkContribute(false, base);
    expect(benchmarkContribute(base)).toBe(false);
  });
  it("config file wins over env in both directions", () => {
    process.env.AGENTGEM_BENCHMARK_CONTRIBUTE = "1";
    setBenchmarkContribute(false, base);
    expect(benchmarkContribute(base)).toBe(false); // file's false beats truthy env (the precedence crux)
    setBenchmarkContribute(true, base);
    delete process.env.AGENTGEM_BENCHMARK_CONTRIBUTE;
    expect(benchmarkContribute(base)).toBe(true);  // file's true stands with env unset
  });
  it("falls back to false on corrupt config file", () => {
    const dir = join(base, ".agentgem", "benchmark");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{not valid json", "utf8");
    expect(benchmarkContribute(base)).toBe(false);
  });
});
