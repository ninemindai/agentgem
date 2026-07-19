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
    expect(parseGemitArgs([])).toEqual({ theme: "rpg", open: true, help: false, share: false, yes: false });
    expect(parseGemitArgs(["--dir", "/x", "--out", "r.html", "--no-open"])).toEqual({
      theme: "rpg", open: false, help: false, share: false, yes: false, dir: "/x", out: "r.html",
    });
    expect(parseGemitArgs(["--share", "--yes"])).toMatchObject({ share: true, yes: true });
    expect(parseGemitArgs(["-y"])).toMatchObject({ yes: true });
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

  describe("--share", () => {
    // fakeData with names that must never reach the shared copy.
    const namedData = () => fakeData({ topSkills: ["secret-skill"], topSubagents: ["secret-agent"] });

    function shareDeps(over: Record<string, unknown> = {}) {
      const published: unknown[] = [];
      const h = deps({
        compute: namedData,
        render: undefined, // share path renders with the real theme; local report may too
        ensureBound: async () => "tester",
        confirm: async () => true,
        publish: async (args: unknown) => { published.push(args); return { shared: true as const, publishedBy: "tester" }; },
        open: () => {},
        ...over,
      });
      return { ...h, published };
    }

    it("publishes after confirm and prints share + X URLs", async () => {
      const h = shareDeps();
      const code = await runGemitCommand(["--share", "--no-open"], h.deps);
      expect(code).toBe(0);
      expect(h.published).toHaveLength(1);
      const arg = h.published[0] as { manifest: { gemKey: string; visibility: string } };
      expect(arg.manifest.gemKey).toBe("tester/gemit-2026-07-18");
      expect(arg.manifest.visibility).toBe("unlisted");
      const all = h.out.join("\n");
      expect(all).toContain("https://app.agentgem.ai/games/tester/gemit-2026-07-18");
      expect(all).toContain("x.com/intent/post");
    });

    it("does not publish when the confirm prompt is declined", async () => {
      const h = shareDeps({ confirm: async () => false });
      expect(await runGemitCommand(["--share", "--no-open"], h.deps)).toBe(0);
      expect(h.published).toHaveLength(0);
      expect(h.out.join("\n")).toContain("Not published");
    });

    it("refuses non-TTY share without --yes", async () => {
      const h = shareDeps({ isTTY: false });
      expect(await runGemitCommand(["--share"], h.deps)).toBe(2);
      expect(h.published).toHaveLength(0);
    });

    it("--yes skips the prompt (works non-TTY)", async () => {
      let confirmCalled = false;
      const h = shareDeps({ isTTY: false, confirm: async () => { confirmCalled = true; return true; } });
      expect(await runGemitCommand(["--share", "--yes"], h.deps)).toBe(0);
      expect(h.published).toHaveLength(1);
      expect(confirmCalled).toBe(false);
    });

    it("errors when binding fails", async () => {
      const h = shareDeps({ ensureBound: async () => null });
      expect(await runGemitCommand(["--share", "--yes"], h.deps)).toBe(1);
      expect(h.published).toHaveLength(0);
      expect(h.err.join("\n")).toContain("bind");
    });

    it("skips share on insufficient data", async () => {
      const h = shareDeps({ compute: () => fakeData({ insufficient: true, qualifyingSessions: 2 }) });
      expect(await runGemitCommand(["--share", "--yes"], h.deps)).toBe(0);
      expect(h.published).toHaveLength(0);
    });

    it("surfaces a publish rejection", async () => {
      const h = shareDeps({ publish: async () => ({ shared: false as const, rejected: "conflict" }) });
      expect(await runGemitCommand(["--share", "--yes"], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("conflict");
    });

    it("writes the share html beside the report and never ships names", async () => {
      const h = shareDeps();
      expect(await runGemitCommand(["--share", "--yes", "--no-open"], h.deps)).toBe(0);
      const shareWrite = h.writes.find((w) => w.path.endsWith(".share.html"));
      expect(shareWrite).toBeDefined();
      expect(shareWrite!.content).not.toContain("secret-skill");
      expect(shareWrite!.content).not.toContain("secret-agent");
      expect(h.out.join("\n")).toContain(shareWrite!.path);
    });
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
