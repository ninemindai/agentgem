// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARMABLES } from "../registry.js";

const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

function usage() { return WARMABLES.find((w) => w.id === "usage")!; }

describe("usage warmable", () => {
  it("warms on first call, then reports a hit on the second (same sessions)", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    try {
      expect(await usage().warm(null, { dir })).toBe("warmed");
      expect(await usage().warm(null, { dir })).toBe("hit");
      expect(await usage().warm(null, { dir, force: true })).toBe("warmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
