import { describe, it, expect } from "vitest";
import { parseClaudeTranscript } from "../observeScan.js";
import { aggregateObserve, ENGAGED_GAP_CAP_MS, type SessionStat } from "../observeAggregate.js";

const noNormalize = (c: string) => c; // avoid filesystem in a unit test

// t0=10:00:00, t1=10:00:30 (gap 30s), t2=13:00:00 (gap ~3h -> capped), t3=13:00:20 (gap 20s)
const transcript = [
  '{"type":"user","timestamp":"2026-07-29T10:00:00.000Z","cwd":"/proj"}',
  '{"type":"assistant","timestamp":"2026-07-29T10:00:30.000Z","message":{"model":"claude-x","usage":{"output_tokens":5}}}',
  '{"type":"user","timestamp":"2026-07-29T13:00:00.000Z"}',
  '{"type":"assistant","timestamp":"2026-07-29T13:00:20.000Z","message":{"model":"claude-x"}}',
].join("\n");

describe("parseClaudeTranscript engagedMs", () => {
  it("strips the idle gap: engaged << span", () => {
    const s = parseClaudeTranscript(transcript, "/tmp/abc.jsonl", noNormalize)!;
    expect(s).not.toBeNull();
    // 30s + capped(3h)=5min + 20s
    expect(s.engagedMs).toBe(30_000 + ENGAGED_GAP_CAP_MS + 20_000);
    const spanMs = s.endMs - s.startMs; // ~3h20s
    expect(s.engagedMs!).toBeLessThan(spanMs / 10);
  });
});

describe("aggregateObserve pulse.activeMs", () => {
  const base: SessionStat = {
    agent: "claude", sessionId: "s", project: "p", model: "m", gitBranch: null,
    startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 0, tokensOut: 0, tokensCache: 0,
  };
  it("sums engagedMs, falling back to span when a stat omits it", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "a", engagedMs: 350_000 },        // engaged provided
      { ...base, sessionId: "b", startMs: 0, endMs: 5000 },   // no engagedMs -> span 5000
    ];
    const p = aggregateObserve(stats, "all", 10_000);
    expect(p.pulse.activeMs).toBe(350_000 + 5000);
  });
});
