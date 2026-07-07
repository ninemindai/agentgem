// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../gem.controller.js";
import { InvalidInputError } from "@agentgem/model";   // same class the controller throws — required for toBeInstanceOf

// summarizeSession scans the DEFAULT store: resolveDirs() reads $HOME, agentgemHome()
// reads AGENTGEM_HOME. Set BOTH to a fresh empty home and write a Claude session under it.
const saved = { home: process.env.HOME, agem: process.env.AGENTGEM_HOME };
const homes: string[] = [];
function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "agentgem-test-home-"));
  homes.push(h);
  process.env.HOME = h; process.env.AGENTGEM_HOME = h;
  return h;
}
function writeClaudeSession(home: string, sessionId: string): void {
  const projDir = join(home, ".claude", "projects", "proj"); mkdirSync(projDir, { recursive: true });
  const t = "2026-07-01T10:00:0";
  const lines = [
    { type: "user", cwd: "/repo", gitBranch: "main", timestamp: `${t}0Z`, message: { role: "user", content: "fix the bug" } },
    { type: "assistant", cwd: "/repo", timestamp: `${t}1Z`, message: { role: "assistant", model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 40 },
      content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" } }] } },
    { type: "user", cwd: "/repo", timestamp: `${t}2Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } },
    { type: "assistant", cwd: "/repo", timestamp: `${t}3Z`, message: { role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "pnpm test" } }] } },
    { type: "user", cwd: "/repo", timestamp: `${t}4Z`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "1 passed" }] } },
  ];
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}
afterEach(async () => {
  const { clearScanCache } = await import("@agentgem/insight");
  clearScanCache();
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.agem === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = saved.agem;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("GemController.inspectSessionProcess", () => {
  it("returns a SessionSummary with a populated process block for a Claude session", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-1");
    const { clearScanCache } = await import("@agentgem/insight"); clearScanCache();
    const out = await new GemController().inspectSessionProcess({ query: { id: "sess-1", agent: "claude" } });
    expect(out.sessionId).toBe("sess-1");
    expect(out.process).not.toBeNull();
    expect(typeof out.process!.score).toBe("number");
    expect(["disciplined", "loose", "chaotic"]).toContain(out.process!.label);
    expect(out.process!.stages).toMatchObject({ implementation: expect.any(Number), verification: expect.any(Number) });
    expect(Array.isArray(out.findings)).toBe(true);
  });

  it("rejects a non-Claude agent with InvalidInputError", async () => {
    newHome();
    await expect(new GemController().inspectSessionProcess({ query: { id: "x", agent: "codex" } }))
      .rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects an unknown session id with InvalidInputError", async () => {
    newHome();
    const { clearScanCache } = await import("@agentgem/insight"); clearScanCache();
    await expect(new GemController().inspectSessionProcess({ query: { id: "nope", agent: "claude" } }))
      .rejects.toBeInstanceOf(InvalidInputError);
  });
});
