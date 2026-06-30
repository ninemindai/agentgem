// src/gem/__tests__/insightsCache.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInsightsCache, writeInsightsCache, insightsToken } from "@agentgem/insight";
import { readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.AGENTGEM_HOME;
  home = mkdtempSync(join(tmpdir(), "agcache-"));
  process.env.AGENTGEM_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("insightsCache", () => {
  it("round-trips a report for (root, token)", () => {
    expect(readInsightsCache("/r", "t1")).toBeNull();
    writeInsightsCache("/r", "t1", { narrative: "x" }, 1);
    expect(readInsightsCache("/r", "t1")).toEqual({ narrative: "x" });
  });

  it("misses on a changed token (sessions changed)", () => {
    writeInsightsCache("/r", "t1", { a: 1 }, 1);
    expect(readInsightsCache("/r", "t2")).toBeNull();
  });

  it("does not collide with the workflow analysis cache for the same root", () => {
    writeAnalysisCache("/r", "wtok", { kind: "analysis" }, 1);
    writeInsightsCache("/r", "itok", { kind: "insights" }, 2);
    // separate namespaces — neither write evicts the other
    expect(readAnalysisCache("/r", "wtok")).toEqual({ kind: "analysis" });
    expect(readInsightsCache("/r", "itok")).toEqual({ kind: "insights" });
  });

  it("insightsToken changes when the transcript count changes", () => {
    expect(insightsToken([])).not.toBe(insightsToken(["/x"]));
  });
});
