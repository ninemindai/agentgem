// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache, writeAnalysisCache } from "@agentgem/insight";
import { SCORECARD_CACHE_ROOT } from "@agentgem/app/gem/scorecard";
import { HomeController, CLAUDE_GATE_MIN_SESSIONS } from "@agentgem/app/home.controller";
import { useHermeticHome } from "./support/hermeticHome.js";
import { createWorkspace, deleteWorkspace } from "@agentgem/base";
import type { Gem } from "@agentgem/model";

let restoreHome: () => void;
let home: string;
beforeEach(() => {
  restoreHome = useHermeticHome();
  home = process.env.HOME!;
  clearScanCache();
});
afterEach(() => {
  restoreHome();
  clearScanCache();
});

// One Claude session directory (`.claude/projects/<project>/<sessionId>.jsonl`) with a
// user record (cwd + start time) and an assistant record (end time + usage tokens) —
// the minimal shape parseClaudeTranscript needs to count a session.
function claudeSession(
  project: string, sessionId: string,
  opts: { startIso: string; endIso: string; tokensIn?: number; tokensOut?: number; tokensCache?: number },
): void {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", timestamp: opts.startIso, cwd: `/home/u/${project}`, message: { content: "hi" } }),
    JSON.stringify({
      type: "assistant", timestamp: opts.endIso,
      message: {
        model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: opts.tokensIn ?? 0, output_tokens: opts.tokensOut ?? 0, cache_read_input_tokens: opts.tokensCache ?? 0 },
      },
    }),
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

describe("HomeController.summary", () => {
  it("returns a zeroed composed shape on an empty home (both gate flags trip)", async () => {
    const out = await new HomeController().summary();
    expect(out).toEqual({
      usage: { sessions: 0, spanDays: 0, activeMs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
      claudeSessions: 0,
      gate: { usageEmpty: true, claudeBelowGate: true },
      scorecardCached: false,
      projectsScanned: 0,
      projectsCap: 12,
    });
  });

  it("aggregates usage totals across Claude sessions (tokens, activeMs, spanDays)", async () => {
    claudeSession("proj-a", "s1", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-01T00:10:00Z", tokensIn: 100, tokensOut: 50, tokensCache: 10 });
    claudeSession("proj-a", "s2", { startIso: "2026-07-03T00:00:00Z", endIso: "2026-07-03T00:05:00Z", tokensIn: 200, tokensOut: 20, tokensCache: 5 });

    const out = await new HomeController().summary();
    expect(out.usage.sessions).toBe(2);
    expect(out.usage.tokensIn).toBe(300);
    expect(out.usage.tokensOut).toBe(70);
    expect(out.usage.tokensCache).toBe(15);
    expect(out.usage.activeMs).toBe(10 * 60_000 + 5 * 60_000);
    expect(out.usage.spanDays).toBe(2); // 2026-07-01T00:00 -> 2026-07-03T00:05, rounds to 2
    expect(out.claudeSessions).toBe(2);
    expect(out.gate.usageEmpty).toBe(false);
    expect(out.gate.claudeBelowGate).toBe(true); // 2 < 10
  });

  it("flips claudeBelowGate at the 9→10 Claude-session boundary", async () => {
    for (let i = 0; i < CLAUDE_GATE_MIN_SESSIONS - 1; i++) {
      claudeSession("proj-b", `s${i}`, { startIso: `2026-07-01T00:0${i}:00Z`, endIso: `2026-07-01T00:0${i}:30Z` });
    }
    const below = await new HomeController().summary();
    expect(below.claudeSessions).toBe(9);
    expect(below.gate.claudeBelowGate).toBe(true);

    claudeSession("proj-b", "s9", { startIso: "2026-07-01T00:09:00Z", endIso: "2026-07-01T00:09:30Z" });
    clearScanCache(); // force a re-scan now that a 10th session landed
    const atGate = await new HomeController().summary();
    expect(atGate.claudeSessions).toBe(10);
    expect(atGate.gate.claudeBelowGate).toBe(false);
  });

  it("scorecardCached reflects whether an aggregate scorecard cache entry exists", async () => {
    const before = await new HomeController().summary();
    expect(before.scorecardCached).toBe(false);

    writeAnalysisCache(SCORECARD_CACHE_ROOT, "tok", { breadth: 1, battleTested: 0, portable: 0, gaps: [], projects: [], generatedAtMs: 1, degraded: false }, Date.now());
    const after = await new HomeController().summary();
    expect(after.scorecardCached).toBe(true);
  });

  it("caps projectsScanned at projectsCap (12) when more projects are discovered", async () => {
    for (let i = 0; i < 15; i++) {
      claudeSession(`proj-${i}`, "s1", { startIso: `2026-07-0${(i % 9) + 1}T00:00:00Z`, endIso: `2026-07-0${(i % 9) + 1}T00:01:00Z` });
    }
    const out = await new HomeController().summary();
    expect(out.projectsScanned).toBe(12);
    expect(out.projectsCap).toBe(12);
  });

  it("reports the exact discovered count when under the cap", async () => {
    claudeSession("proj-x", "s1", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-01T00:01:00Z" });
    claudeSession("proj-y", "s1", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-01T00:01:00Z" });
    const out = await new HomeController().summary();
    expect(out.projectsScanned).toBe(2);
  });
});

const gem: Gem = { name: "demo", createdFrom: "/d", artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s" }], checks: [], requiredSecrets: [] };

describe("HomeController.state", () => {
  it("fresh home: not existingUser, locked", async () => {
    const out = await new HomeController().state();
    expect(out).toEqual({ unlocked: false, existingUser: false, revealSeen: false });
  });

  it("pre-existing artifact (transcript index): existingUser + unlocked, on the very first read", async () => {
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "transcript-index.db"), "");
    const out = await new HomeController().state();
    expect(out).toEqual({ unlocked: true, existingUser: true, revealSeen: false });
  });

  it("a home-state.json already on disk (a prior read) is not re-derived from artifacts written later", async () => {
    // First read on a genuinely fresh home locks in existingUser=false...
    await new HomeController().state();
    // ...so a scan cache written afterward (e.g. by /home/summary) must not flip it retroactively.
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "transcript-index.db"), "");
    const out = await new HomeController().state();
    expect(out.existingUser).toBe(false);
  });

  it("POST unlocked:true persists across reads", async () => {
    const posted = await new HomeController().setState({ body: { unlocked: true } });
    expect(posted.unlocked).toBe(true);
    const out = await new HomeController().state();
    expect(out.unlocked).toBe(true);
  });

  it("POST unlocked:false is ignored (one-way — no unlock, no re-lock)", async () => {
    const out = await new HomeController().setState({ body: { unlocked: false } });
    expect(out.unlocked).toBe(false);
  });

  it("POST revealSeen:true persists across reads", async () => {
    const posted = await new HomeController().setState({ body: { revealSeen: true } });
    expect(posted.revealSeen).toBe(true);
    const out = await new HomeController().state();
    expect(out.revealSeen).toBe(true);
    expect(out.unlocked).toBe(false); // revealSeen alone doesn't unlock
  });

  it("gems-exist path unlocks, and deleting the only gem does not re-lock (latched unlockedAt)", async () => {
    const before = await new HomeController().state();
    expect(before.unlocked).toBe(false);

    createWorkspace("mp", gem);
    const withGem = await new HomeController().state();
    expect(withGem.unlocked).toBe(true);

    deleteWorkspace("mp");
    const afterDelete = await new HomeController().state();
    expect(afterDelete.unlocked).toBe(true); // latched — deleting gems never re-locks
  });

  it("POST unlocked:false after already-unlocked stays a no-op (unlocked stays true, file unchanged)", async () => {
    await new HomeController().setState({ body: { unlocked: true } });
    const statePath = join(home, ".agentgem", "home-state.json");
    const before = readFileSync(statePath, "utf8");

    const out = await new HomeController().setState({ body: { unlocked: false } });
    expect(out.unlocked).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe(before); // no write happened at all
  });

  it("corrupt home-state.json self-heals: re-derives existingUser from artifacts and repairs the file on disk", async () => {
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "transcript-index.db"), "");
    writeFileSync(join(home, ".agentgem", "home-state.json"), "{ this is not json ]["); // torn/corrupt write

    const out = await new HomeController().state();
    expect(out).toEqual({ unlocked: true, existingUser: true, revealSeen: false });

    const onDisk = JSON.parse(readFileSync(join(home, ".agentgem", "home-state.json"), "utf8"));
    expect(onDisk.existingUser).toBe(true); // repaired on disk, not left corrupt
  });

  it("existing-user config.json check reads os.homedir() (the writer's actual path), not agentgemHome() — they can diverge", async () => {
    // Point AGENTGEM_HOME somewhere OTHER than HOME/os.homedir() (useHermeticHome starts them
    // equal). src/agentgemConfig.ts always writes config.json under os.homedir(), so detection
    // must check that exact path — not `<agentgemHome()>/.agentgem/config.json`, which would
    // silently miss it whenever the two diverge (the config-existence bug this test guards).
    const altAgentgemHome = mkdtempSync(join(tmpdir(), "agem-alt-"));
    const prevAgentgemHome = process.env.AGENTGEM_HOME;
    process.env.AGENTGEM_HOME = altAgentgemHome;
    try {
      mkdirSync(join(home, ".agentgem"), { recursive: true });
      writeFileSync(join(home, ".agentgem", "config.json"), JSON.stringify({ shareAdoption: true }));

      const out = await new HomeController().state();
      expect(out.existingUser).toBe(true);
      expect(out.unlocked).toBe(true);
      // home-state.json is persisted under the (different) AGENTGEM_HOME, proving the config
      // check didn't just coincidentally hit the same directory.
      expect(existsSync(join(altAgentgemHome, ".agentgem", "home-state.json"))).toBe(true);
    } finally {
      if (prevAgentgemHome !== undefined) process.env.AGENTGEM_HOME = prevAgentgemHome;
      else delete process.env.AGENTGEM_HOME;
      rmSync(altAgentgemHome, { recursive: true, force: true });
    }
  });
});
