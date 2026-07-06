// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextSeriesScan.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanWorkflow } from "@agentgem/insight";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTranscript(dir: string): string {
  const lines = [
    { sessionId: "sess1", type: "user", message: { role: "user", content: "do a thing" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/f.ts" } }],
        usage: { input_tokens: 100, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 2000, output_tokens: 40 } } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/g.ts" } }],
        usage: { input_tokens: 100, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 6000, output_tokens: 20 } } },
  ].map((o) => JSON.stringify(o)).join("\n");
  const p = join(dir, "sess1.jsonl");
  writeFileSync(p, lines);
  return p;
}

describe("scanWorkflow contextSeries", () => {
  it("populates a TurnUsage per assistant turn when retainSequences is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxseries-"));
    const path = writeTranscript(dir);
    const signal = scanWorkflow([path], emptyInv, { retainSequences: true });
    const session = signal.sequences?.sessions?.[0];
    expect(session?.contextSeries).toBeDefined();
    expect(session!.contextSeries!).toHaveLength(2);
    expect(session!.contextSeries![0].ctxTokens).toBe(502_100);   // 100 + 500000 + 2000
    expect(session!.contextSeries![1].cacheCreation).toBe(6000);
    expect(session!.contextSeries![0].turn).toBe(0);
    expect(session!.contextSeries![1].turn).toBe(1);
  });
});
