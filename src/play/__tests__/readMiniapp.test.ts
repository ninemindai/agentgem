// src/play/__tests__/readMiniapp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "T", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };

describe("readMiniapp", () => {
  it("returns the html + meta for a saved miniapp", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const r = readMiniapp("g1");
    expect(r.name).toBe("g1");
    expect(r.html).toContain("canvas");
    expect(r.meta.title).toBe("T");
  });
  it("throws for an unknown miniapp", () => { expect(() => readMiniapp("nope")).toThrow(); });
});
