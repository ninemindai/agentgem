// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "@agentgem/model";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("writeJsonAtomic", () => {
  it("writes valid JSON, overwrites, and leaves no temp file", () => {
    dir = mkdtempSync(join(tmpdir(), "aw-"));
    const p = join(dir, "sub", "cache.json");   // parent dir does not exist yet
    writeJsonAtomic(p, { a: 1 });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 1 });
    writeJsonAtomic(p, { a: 2, b: [3] });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 2, b: [3] });
    // no leftover *.tmp in the directory
    expect(readdirSync(join(dir, "sub")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
