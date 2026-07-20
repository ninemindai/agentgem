import { describe, it, expect } from "vitest";
import { benchmarks, effectiveness, type BenchmarkHttp } from "@agentgem/app/gem/benchmarkClient";

const ok = (rows: unknown[]): BenchmarkHttp => async () => ({ status: 200, json: async () => rows });

describe("benchmarkClient", () => {
  it("passes through the hosted rows on 200", async () => {
    const rows = [{ model: "opus", mostly: 3 }];
    expect(await benchmarks({ endpoint: "https://x", http: ok(rows) })).toEqual(rows);
  });
  it("hits the effectiveness path with sort+minConfidence", async () => {
    let seen = "";
    const http: BenchmarkHttp = async (url) => { seen = url; return { status: 200, json: async () => [] }; };
    await effectiveness({ endpoint: "https://x", sort: "score", minConfidence: 0.3, http });
    expect(seen).toBe("https://x/api/aggregator/effectiveness?sort=score&minConfidence=0.3");
  });
  it("returns [] on a 5xx", async () => {
    const http: BenchmarkHttp = async () => ({ status: 500, json: async () => ({}) });
    expect(await benchmarks({ endpoint: "https://x", http })).toEqual([]);
  });
  it("returns [] on a thrown/timeout error", async () => {
    const http: BenchmarkHttp = async () => { throw new Error("network"); };
    expect(await effectiveness({ endpoint: "https://x", http })).toEqual([]);
  });
});
