// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAskConnectFnForTests, clearScanCache } from "@agentgem/insight";
import type { AcpConnectFn } from "@agentgem/insight";
import { RecallIndex } from "@agentgem/recall";
import { GoldmineTools } from "../mcpServer.js";
import { defaultRecallDbPath } from "@agentgem/app/goldmine/recall";

// Both HOME and AGENTGEM_HOME must point at the fixture dir: the Claude scan path
// (resolveDirs()) derives its default from os.homedir() (i.e. $HOME), while
// AGENTGEM_HOME-based state derives separately — the same dual-override the
// codebase's own sessionSummary.test.ts fixture uses.
const savedHome = process.env.HOME;
const savedAgentgemHome = process.env.AGENTGEM_HOME;
const cleanup: string[] = [];
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedAgentgemHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = savedAgentgemHome;
  setAskConnectFnForTests(null);
  clearScanCache();
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "agentgem-home-")); cleanup.push(h);
  process.env.HOME = h;
  process.env.AGENTGEM_HOME = h;
  const projDir = join(h, ".claude", "projects", "proj"); mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "sess-1.jsonl"), [
    JSON.stringify({ type: "user", cwd: "/repo", gitBranch: "main", timestamp: "2026-07-01T10:00:00Z", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", cwd: "/repo", timestamp: "2026-07-01T10:00:01Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/repo/a.ts" } }] } }),
  ].join("\n"));
  return h;
}

describe("GoldmineTools", () => {
  it("summarize_session returns a deterministic aggregate", async () => {
    home();
    const tools = new GoldmineTools();
    const r = await tools.summarizeSessionTool({ sessionId: "sess-1", agent: "claude" });
    expect(r.summary).not.toBeNull();
    expect(r.summary!.sessionId).toBe("sess-1");
    expect(JSON.stringify(r.summary)).not.toContain("/repo/a.ts"); // secret-safe
  });

  it("ask_session routes through the injected ACP fake and returns its answer", async () => {
    home();
    const fake: AcpConnectFn = async () => ({ ctx: { async open() { return { async setMode() {}, async promptText() { return "it edited a.ts once."; }, dispose() {} }; } }, close() {} });
    setAskConnectFnForTests(fake);
    const tools = new GoldmineTools();
    const r = await tools.askSessionTool({ sessionId: "sess-1", agent: "claude", question: "what happened?" });
    expect(r.result.answered).toBe(true);
    expect(r.result.answer).toBe("it edited a.ts once.");
  });

  it("search_session_content returns moments from the on-disk recall index", async () => {
    home();
    const idx = new RecallIndex(defaultRecallDbPath());
    idx.upsertSession(
      { sessionId: "sess-1", agent: "claude", project: "proj", branch: "main", startMs: Date.now() },
      [{ turn: 0, text: "prod db migration" }],
      "v1",
    );
    idx.close();
    const tools = new GoldmineTools();
    const r = await tools.searchSessionContentTool({ query: "migration", limit: 5 });
    expect(r.moments.length).toBe(1);
    expect(r.moments[0].sessionId).toBe("sess-1");
  });

  it("no longer exposes a get_session_transcript method", () => {
    const tools = new GoldmineTools() as unknown as Record<string, unknown>;
    expect(typeof tools.getSessionTranscriptTool).toBe("undefined");
  });
});
