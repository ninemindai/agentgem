// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/eventSeriesScan.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanWorkflow } from "@agentgem/insight";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTranscript(dir: string): string {
  const lines = [
    { sessionId: "sess1", type: "user", message: { role: "user", content: "do a thing" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "superpowers:brainstorming" } }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Task", input: { subagent_type: "Explore", description: "look around" } }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }, // NOT an event
  ].map((o) => JSON.stringify(o)).join("\n");
  const p = join(dir, "sess1.jsonl");
  writeFileSync(p, lines);
  return p;
}

describe("scanWorkflow eventSeries", () => {
  it("captures skill and subagent invocations by msgIndex, uncapped and skill-named, ignoring plain Bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "evtseries-"));
    const path = writeTranscript(dir);
    const signal = scanWorkflow([path], emptyInv, { retainSequences: true });
    const session = signal.sequences?.sessions?.[0];
    expect(session?.eventSeries).toEqual([
      { msgIndex: expect.any(Number), kind: "skill", name: "superpowers:brainstorming" },
      { msgIndex: expect.any(Number), kind: "agent", name: "Explore" },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
