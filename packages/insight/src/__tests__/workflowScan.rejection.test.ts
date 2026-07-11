// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { scanWorkflow } from "../workflowScan.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMPTY_INV = { project: { skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } };

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const p = join(dir, "sess-1.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return p;
}

describe("workflowScan tool-result outcome", () => {
  it("marks a step error when its tool_result is_error", () => {
    const p = transcript([
      { sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }] } },
      { sessionId: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] } },
    ]);
    const sig = scanWorkflow([p], EMPTY_INV as any, { retainSequences: true });
    const step = sig.sequences!.sessions[0].steps.find((s) => s.toolUseId === "t1");
    expect(step?.error).toBe(true);
  });

  it("leaves error undefined when there is no result (legacy/interrupted)", () => {
    const p = transcript([
      { sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "y" } }] } },
    ]);
    const sig = scanWorkflow([p], EMPTY_INV as any, { retainSequences: true });
    const step = sig.sequences!.sessions[0].steps.find((s) => s.toolUseId === "t2");
    expect(step?.error).toBeUndefined();
  });

  it("marks a step rejected when its tool_result carries the denial marker", () => {
    const p = transcript([
      { sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "x" } }] } },
      { sessionId: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected" }] } },
    ]);
    const sig = scanWorkflow([p], EMPTY_INV as any, { retainSequences: true });
    const step = sig.sequences!.sessions[0].steps.find((s) => s.toolUseId === "t3");
    expect(step?.error).toBe(true);
    expect(step?.rejected).toBe(true);
  });

  it("leaves rejected falsy for a non-denial error", () => {
    const p = transcript([
      { sessionId: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "x" } }] } },
      { sessionId: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t4", is_error: true, content: "boom" }] } },
    ]);
    const sig = scanWorkflow([p], EMPTY_INV as any, { retainSequences: true });
    const step = sig.sequences!.sessions[0].steps.find((s) => s.toolUseId === "t4");
    expect(step?.error).toBe(true);
    expect(step?.rejected).not.toBe(true);
  });
});
