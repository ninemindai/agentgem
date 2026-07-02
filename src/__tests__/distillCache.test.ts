// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDistillCache, readDistillCache, readDistillCacheEntry } from "@agentgem/insight";

let dir: string | undefined;
const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

describe("distillCache", () => {
  it("round-trips a (root, token) entry with its write ts, misses otherwise", () => {
    dir = mkdtempSync(join(tmpdir(), "dc-")); process.env.AGENTGEM_HOME = dir;
    writeDistillCache("/proj", "d1:1:5", { skills: [], lessons: [{ x: 1 }], degraded: false }, 4242);
    expect(readDistillCache("/proj", "d1:1:5")).toEqual({ skills: [], lessons: [{ x: 1 }], degraded: false });
    expect(readDistillCacheEntry("/proj", "d1:1:5")).toEqual({ result: { skills: [], lessons: [{ x: 1 }], degraded: false }, ts: 4242 });
    expect(readDistillCacheEntry("/proj", "other")).toBeNull();
  });
});
