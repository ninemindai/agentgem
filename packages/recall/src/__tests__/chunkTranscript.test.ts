// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { chunkTranscript } from "../chunkTranscript.js";
import type { TranscriptView } from "@agentgem/insight";

const view = {
  sessionId: "s1", agent: "claude", model: null, project: "p", startMs: 0, endMs: 1,
  turns: [
    { index: 0, role: "user", spans: [{ kind: "message", role: "user", text: "fix the migration" }] },
    { index: 1, role: "assistant", spans: [
      { kind: "message", role: "assistant", text: "running it" },
      { kind: "tool_call", name: "Bash", input: "alter table x add column y", output: "OK" },
    ] },
    { index: 2, role: "assistant", spans: [{ kind: "message", role: "assistant", text: "   " }] },
  ],
} as unknown as TranscriptView;

describe("chunkTranscript", () => {
  it("emits one chunk per non-empty turn, rendering messages and tool calls", () => {
    const chunks = chunkTranscript(view);
    expect(chunks.map((c) => c.turn)).toEqual([0, 1]); // turn 2 is whitespace-only → dropped
    expect(chunks[0].text).toContain("fix the migration");
    expect(chunks[1].text).toContain("running it");
    expect(chunks[1].text).toContain("Bash(alter table x add column y) -> OK");
  });

  it("bounds each chunk to maxCharsPerTurn", () => {
    const big = { ...view, turns: [{ index: 0, role: "user", spans: [{ kind: "message", role: "user", text: "x".repeat(9000) }] }] } as unknown as TranscriptView;
    const chunks = chunkTranscript(big, { maxCharsPerTurn: 100 });
    expect(chunks[0].text.length).toBeLessThanOrEqual(100);
  });
});
