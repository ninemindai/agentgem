// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askSession, setAskConnectFnForTests, clearScanCache } from "@agentgem/insight";
import type { AcpConnectFn } from "@agentgem/insight";

// Fixture under <home>/.claude/projects/proj/ — askSession has no `dirs` param, so
// it resolves the transcript via AGENTGEM_HOME (same isolation as Task 1).
function writeClaudeSession(home: string, sessionId: string): void {
  const projDir = join(home, ".claude", "projects", "proj"); mkdirSync(projDir, { recursive: true });
  const lines = [
    { type: "user", cwd: "/repo", timestamp: "2026-07-01T10:00:00Z", message: { role: "user", content: "add retry logic to the fetch helper" } },
    { type: "assistant", cwd: "/repo", timestamp: "2026-07-01T10:00:01Z", message: { role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "text", text: "Added exponential backoff to fetchWithRetry." }] } },
  ];
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

// A fake ACP connection that records the prompt it was given and returns a canned answer.
let lastPrompt = "";
const fakeConnect: AcpConnectFn = async () => ({
  ctx: { async open() { return {
    async setMode() {},
    async promptText(text: string) { lastPrompt = text; return "The retry logic uses exponential backoff, 3 attempts."; },
    dispose() {},
  }; } },
  close() {},
});

// Both HOME and AGENTGEM_HOME must point at the fixture dir: the Claude scan path
// (resolveDirs()) derives its default from os.homedir() (i.e. $HOME), while
// AGENTGEM_HOME-based state derives separately — the same dual-override the
// codebase's own hermeticHome.ts fixture (and sessionSummary.test.ts) uses.
const savedHome = process.env.HOME;
const savedAgentgemHome = process.env.AGENTGEM_HOME;
const homes: string[] = [];
function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "agentgem-home-"));
  homes.push(h);
  process.env.HOME = h;
  process.env.AGENTGEM_HOME = h;
  return h;
}
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedAgentgemHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = savedAgentgemHome;
  setAskConnectFnForTests(null); clearScanCache(); lastPrompt = "";
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("askSession", () => {
  it("feeds the raw scrubbed transcript to the ACP subprocess and returns only its answer", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-1");
    setAskConnectFnForTests(fakeConnect);
    const r = await askSession("sess-1", "claude", "what retry strategy was used?");
    expect(r.answered).toBe(true);
    expect(r.agentUsed).toBe("claude-code");
    expect(r.answer).toBe("The retry logic uses exponential backoff, 3 attempts.");
    // the raw transcript content reached the SUBPROCESS prompt (not the result)
    expect(lastPrompt).toContain("add retry logic to the fetch helper");
    expect(lastPrompt).toContain("what retry strategy was used?");
  });

  it("returns answered:false without connecting for a source with no native ACP agent", async () => {
    newHome();
    let connected = false;
    setAskConnectFnForTests(async () => { connected = true; return { ctx: { async open() { return { async setMode() {}, async promptText() { return ""; }, dispose() {} }; } }, close() {} }; });
    const r = await askSession("whatever", "atif", "q?");     // atif has no ACP agent family
    expect(r.answered).toBe(false);
    expect(r.agentUsed).toBeNull();
    expect(connected).toBe(false);
    expect(r.answer).toMatch(/summarize_session/);
  });

  it("returns answered:false when the session is not found", async () => {
    newHome();
    setAskConnectFnForTests(fakeConnect);
    const r = await askSession("nope", "claude", "q?");
    expect(r.answered).toBe(false);
    expect(r.answer).toMatch(/not found/i);
  });

  it("windows an over-cap transcript instead of dropping it", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-big");
    setAskConnectFnForTests(fakeConnect);
    const r = await askSession("sess-big", "claude", "q?", { maxChars: 50 });
    expect(r.answered).toBe(true);
    expect(lastPrompt.length).toBeLessThan(2000);      // capped, not the full render
    expect(lastPrompt).toMatch(/elided|truncated/i);   // windowing marker present
  });
});
