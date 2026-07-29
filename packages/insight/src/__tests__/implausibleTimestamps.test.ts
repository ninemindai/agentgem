// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// startMs/endMs are Math.min/Math.max reductions over every record in a transcript, so
// a SINGLE corrupt timestamp is not a rounding error — it becomes the boundary of the
// whole history. A record stamped at the Unix epoch made the reveal's usage ledger read
// "20664 days" (epoch-to-today) because `Date.parse` returned 0 and 0 is not NaN, which
// was the only validity test the scan applied.
import { describe, it, expect } from "vitest";
import { parseClaudeTranscript, parseCodexTranscript } from "../observeScan.js";

const noNormalize = (c: string) => c; // avoid filesystem in a unit test

// The contract, asserted independently of the implementation's own constant: no agent
// transcript can predate the agents that write them (Claude Code shipped in 2025), so
// 2023-01-01 is a floor no genuine session can fall below.
const FLOOR_MS = Date.UTC(2023, 0, 1);

const REAL_START = Date.parse("2026-07-01T00:00:00.000Z");
const REAL_END = Date.parse("2026-07-01T00:10:00.000Z");

describe("scan rejects implausible transcript timestamps", () => {
  it("ignores a Unix-epoch record instead of adopting it as the session start", () => {
    const text = [
      // Date.parse -> exactly 0. Not NaN, so the old guard let it win the Math.min.
      JSON.stringify({ type: "user", timestamp: "1970-01-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:10:00.000Z", message: { model: "claude-x" } }),
    ].join("\n");

    const s = parseClaudeTranscript(text, "/tmp/abc.jsonl", noNormalize)!;
    expect(s).not.toBeNull();
    expect(s.startMs).toBe(REAL_START);
    expect(s.endMs).toBe(REAL_END);
  });

  it("ignores a pre-agent-era date, not just the epoch itself", () => {
    // A plugin defaulting a missing field, or a hand-written fixture, need not land on 0.
    const text = [
      JSON.stringify({ type: "user", timestamp: "2001-01-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:10:00.000Z", message: { model: "claude-x" } }),
    ].join("\n");

    const s = parseClaudeTranscript(text, "/tmp/abc.jsonl", noNormalize)!;
    expect(s.startMs).toBe(REAL_START);
    expect(s.startMs).toBeGreaterThanOrEqual(FLOOR_MS);
  });

  it("drops a transcript whose timestamps are ALL implausible, rather than dating it to 1970", () => {
    // Every timestamp rejected leaves no usable range at all — the same outcome as a
    // transcript with no timestamps, which the scan already declines to call a session.
    const text = [
      JSON.stringify({ type: "user", timestamp: "1970-01-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "1970-01-01T00:00:01.000Z", message: { model: "claude-x" } }),
    ].join("\n");

    expect(parseClaudeTranscript(text, "/tmp/abc.jsonl", noNormalize)).toBeNull();
  });

  it("keeps the epoch out of engagedMs too, so a rejected record adds no phantom gap", () => {
    const text = [
      JSON.stringify({ type: "user", timestamp: "1970-01-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", cwd: "/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:30.000Z", message: { model: "claude-x" } }),
    ].join("\n");

    // Only the real 30s gap counts. Had the epoch survived, the first gap would be ~56
    // years — capped, but still a wholly invented 5 minutes of "engaged" time.
    const s = parseClaudeTranscript(text, "/tmp/abc.jsonl", noNormalize)!;
    expect(s.engagedMs).toBe(30_000);
  });

  it("applies the same floor to Codex transcripts", () => {
    const text = [
      JSON.stringify({ type: "session_meta", timestamp: "1970-01-01T00:00:00.000Z", payload: { id: "cx1", cwd: "/proj" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-01T00:00:00.000Z", payload: { type: "message" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-01T00:10:00.000Z", payload: { type: "message" } }),
    ].join("\n");

    const s = parseCodexTranscript(text, "/tmp/rollout-x.jsonl", noNormalize)!;
    expect(s.startMs).toBe(REAL_START);
    expect(s.endMs).toBe(REAL_END);
  });

  it("still accepts genuine timestamps at and after the floor", () => {
    const at = new Date(FLOOR_MS).toISOString();
    const text = [
      JSON.stringify({ type: "user", timestamp: at, cwd: "/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:10:00.000Z", message: { model: "claude-x" } }),
    ].join("\n");

    const s = parseClaudeTranscript(text, "/tmp/abc.jsonl", noNormalize)!;
    expect(s.startMs).toBe(FLOOR_MS); // inclusive boundary, not off-by-one
  });
});
