import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalUsageCache, writeGlobalUsageCache } from "@agentgem/capture";

let home: string, prev: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ugcache-")); prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = home; });
afterEach(() => { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(home, { recursive: true, force: true }); });

describe("global usage cache", () => {
  it("returns the stored result for a matching token", () => {
    const r = { artifacts: [{ type: "skill", name: "diagram", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 1 }] };
    writeGlobalUsageCache("tok-1", r);
    expect(readGlobalUsageCache("tok-1")).toEqual(r);
  });
  it("returns null for a different token (stale)", () => {
    writeGlobalUsageCache("tok-1", { artifacts: [] });
    expect(readGlobalUsageCache("tok-2")).toBeNull();
  });
  it("returns null when nothing was ever written", () => {
    expect(readGlobalUsageCache("anything")).toBeNull();
  });
});
