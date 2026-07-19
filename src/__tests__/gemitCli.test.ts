// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// CLI tests: pure arg parsing + deps-injected command runs (exit codes, output,
// write/open behavior), plus one real temp-dir write.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGemitArgs, runGemitCommand } from "../gemitCli.js";
import type { GemitData } from "../gemit/score.js";

const NOW = Date.UTC(2026, 6, 18);

function fakeData(over: Partial<GemitData> = {}): GemitData {
  return {
    windowFrom: "2026-06-18", windowTo: "2026-07-18",
    qualifyingSessions: 10, scoredSessions: 10, projects: 2,
    totalMsgs: 100, tokensOut: 1000,
    ctx: 90, proc: 80, setup: 40, composite: 76, tierLevel: 3,
    verdicts: { bounded: 9, mixed: 1, bloated: 0 },
    labels: { disciplined: 5, loose: 1, chaotic: 0 },
    verifyRatePct: 50, boundedStreak: 9, firedFindings: [],
    skillVariety: 3, subagentVariety: 2, topSkills: [], topSubagents: [],
    insufficient: false,
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const opened: string[] = [];
  return {
    out, err, writes, opened,
    deps: {
      collect: async () => ({ qualifying: [], scored: [] }),
      compute: () => fakeData(),
      render: (d: GemitData) => `<html>${d.composite}</html>`,
      writeFile: (path: string, content: string) => writes.push({ path, content }),
      open: (p: string) => opened.push(p),
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      isTTY: true,
      nowMs: NOW,
      ...over,
    },
  };
}

describe("parseGemitArgs", () => {
  it("parses defaults and flags", () => {
    expect(parseGemitArgs([])).toEqual({ theme: "rpg", open: true, help: false });
    expect(parseGemitArgs(["--dir", "/x", "--out", "r.html", "--no-open"])).toEqual({
      theme: "rpg", open: false, help: false, dir: "/x", out: "r.html",
    });
    expect(parseGemitArgs(["-h"])).toMatchObject({ help: true });
  });
  it("rejects unknown themes, options, and missing values", () => {
    expect(parseGemitArgs(["--theme", "vaporwave"])).toMatchObject({ error: expect.stringContaining("vaporwave") });
    expect(parseGemitArgs(["--wat"])).toMatchObject({ error: expect.stringContaining("--wat") });
    expect(parseGemitArgs(["--dir"])).toMatchObject({ error: expect.stringContaining("--dir") });
  });
});

describe("runGemitCommand", () => {
  it("scores, writes the rendered report, prints tier + path, opens on TTY", async () => {
    const h = deps();
    const code = await runGemitCommand([], h.deps);
    expect(code).toBe(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].content).toBe("<html>76</html>");
    expect(h.out.join("\n")).toContain("Lapidary — 76/100");
    expect(h.out.join("\n")).toContain(h.writes[0].path);
    expect(h.opened).toEqual([h.writes[0].path]);
  });

  it("respects --no-open and non-TTY", async () => {
    const a = deps();
    await runGemitCommand(["--no-open"], a.deps);
    expect(a.opened).toEqual([]);
    const b = deps({ isTTY: false });
    await runGemitCommand([], b.deps);
    expect(b.opened).toEqual([]);
  });

  it("returns 2 on usage errors, printing to err", async () => {
    const h = deps();
    expect(await runGemitCommand(["--theme", "bogus"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("bogus");
    expect(h.writes).toHaveLength(0);
  });

  it("still writes the doorway report on insufficient data, exit 0", async () => {
    const h = deps({ compute: () => fakeData({ insufficient: true, qualifyingSessions: 2 }) });
    expect(await runGemitCommand([], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Not enough steering yet");
    expect(h.writes).toHaveLength(1);
  });

  it("writes a real file under --out (temp dir)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gemit-"));
    try {
      const h = deps({ writeFile: undefined });
      const target = join(tmp, "nested", "report.html");
      const code = await runGemitCommand(["--out", target, "--no-open"], {
        ...h.deps, writeFile: undefined,
      });
      expect(code).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("<html>76</html>");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
