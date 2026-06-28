import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions, parseClaudeTranscript, parseCodexTranscript, scanSessionsCached, clearScanCache, type SessionStat } from "../observeScan.js";

let home: string, claudeDir: string, codexDir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "observe-"));
  claudeDir = join(home, ".claude");
  codexDir = join(home, ".codex");
  // Claude: ~/.claude/projects/<folder>/<session>.jsonl
  const cproj = join(claudeDir, "projects", "proj-a");
  mkdirSync(cproj, { recursive: true });
  // gitBranch fixture
  writeFileSync(join(cproj, "s-branch.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s-branch", cwd: "/work/app", gitBranch: "feat/x", timestamp: "2026-06-28T09:00:00.000Z", message: { role: "user" } }),
    JSON.stringify({ type: "assistant", sessionId: "s-branch", cwd: "/work/app", timestamp: "2026-06-28T09:00:05.000Z", message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join("\n") + "\n");
  writeFileSync(join(cproj, "s1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:00.000Z", message: { role: "user" } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:05.000Z", message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:01:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    "{ not json",
  ].join("\n") + "\n");
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const xdir = join(codexDir, "sessions", "2026", "06", "28");
  mkdirSync(xdir, { recursive: true });
  writeFileSync(join(xdir, "rollout-x1.jsonl"), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-28T11:00:00.000Z", payload: { id: "x1", cwd: "/work/web", timestamp: "2026-06-28T11:00:00.000Z" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-06-28T11:00:01.000Z", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:02.000Z", payload: { type: "message", role: "assistant" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-28T11:05:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 600 } } } }),
  ].join("\n") + "\n");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("parseClaudeTranscript", () => {
  it("normalizes tokens (fresh in / cache / out), timing, msgs, model", () => {
    const s = parseClaudeTranscript(join(claudeDir, "projects", "proj-a", "s1.jsonl"))!;
    expect(s.agent).toBe("claude");
    expect(s.sessionId).toBe("s1");
    expect(s.project).toBe("app");          // basename of cwd
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.tokensIn).toBe(300);           // 100 + 200 (cache excluded)
    expect(s.tokensOut).toBe(100);          // 40 + 60
    expect(s.tokensCache).toBe(15);         // 10 read + 5 creation
    expect(s.msgs).toBe(3);                 // 1 user + 2 assistant
    expect(s.endMs - s.startMs).toBe(60_000); // 10:00:00 → 10:01:00
  });
});

describe("parseCodexTranscript", () => {
  it("uses cumulative total_token_usage, session_meta id/cwd, found model", () => {
    const s = parseCodexTranscript(join(codexDir, "sessions", "2026", "06", "28", "rollout-x1.jsonl"))!;
    expect(s.agent).toBe("codex");
    expect(s.sessionId).toBe("x1");
    expect(s.project).toBe("web");
    expect(s.model).toBe("gpt-5.5");
    expect(s.tokensIn).toBe(300);           // 500 input − 200 cached
    expect(s.tokensCache).toBe(200);
    expect(s.tokensOut).toBe(100);          // 80 + 20 reasoning
    expect(s.endMs - s.startMs).toBe(300_000); // 11:00:00 → 11:05:00
  });
});

describe("scanSessions", () => {
  it("returns both agents and skips a missing codex dir without throwing", () => {
    const stats = scanSessions({ claudeDir, codexDir });
    expect(stats.map((s) => s.sessionId).sort()).toEqual(["s-branch", "s1", "x1"]);
    const missing = scanSessions({ claudeDir, codexDir: join(home, "nope") });
    expect(missing.map((s) => s.sessionId).sort()).toEqual(["s-branch", "s1"]);
  });
});

import { aggregateObserve, type ObservePayload } from "../observeScan.js";

const mk = (over: Partial<SessionStat>): SessionStat => ({
  agent: "claude", sessionId: "s", project: "app", model: "claude-opus-4-8",
  gitBranch: null, startMs: 0, endMs: 60_000, msgs: 4, tokensIn: 100, tokensOut: 40, tokensCache: 10, ...over,
});

describe("aggregateObserve", () => {
  const NOW = Date.parse("2026-06-28T12:00:00.000Z");
  const day = (iso: string, over: Partial<SessionStat> = {}) =>
    mk({ startMs: Date.parse(iso), endMs: Date.parse(iso) + 60_000, ...over });

  it("buckets by UTC date and totals tokens per day", () => {
    const p = aggregateObserve([
      day("2026-06-28T09:00:00.000Z", { sessionId: "a", tokensIn: 100, tokensOut: 40, tokensCache: 10 }),
      day("2026-06-28T10:00:00.000Z", { sessionId: "b", tokensIn: 200, tokensOut: 60, tokensCache: 0 }),
      day("2026-06-27T10:00:00.000Z", { sessionId: "c" }),
    ], "all", NOW);
    const d28 = p.daily.find((d) => d.date === "2026-06-28")!;
    expect(d28.sessions).toBe(2);
    expect(d28.tokensIn).toBe(300);  // 100+200
    expect(d28.tokensOut).toBe(100); // 40+60
    expect(d28.tokensCache).toBe(10); // 10+0
    expect(d28.msgs).toBe(8);        // 4+4 (mk default msgs=4 each)
    expect(p.daily.map((d) => d.date)).toContain("2026-06-27");
  });

  it("pulse sums the range; range filters by recency", () => {
    const recent = day("2026-06-28T09:00:00.000Z", { sessionId: "r" });
    const old = day("2026-05-01T09:00:00.000Z", { sessionId: "o" });
    const today = aggregateObserve([recent, old], "today", NOW);
    expect(today.sessions.map((s) => s.sessionId)).toEqual(["r"]);
    expect(today.pulse.sessions).toBe(1);
    // pulse fields for the single in-range session (mk defaults: msgs=4, tokensIn=100, tokensOut=40, tokensCache=10)
    expect(today.pulse.tokens).toBe(150);   // 100+40+10
    expect(today.pulse.msgs).toBe(4);
    expect(today.pulse.activeMs).toBe(60_000); // endMs-startMs
    const all = aggregateObserve([recent, old], "all", NOW);
    expect(all.pulse.sessions).toBe(2);
    // both sessions have the same mk defaults → doubled
    expect(all.pulse.tokens).toBe(300);
    expect(all.pulse.msgs).toBe(8);
    expect(all.pulse.activeMs).toBe(120_000);
  });

  it("model-share groups by model+agent", () => {
    const p = aggregateObserve([
      mk({ sessionId: "a", model: "claude-opus-4-8", tokensIn: 100, tokensOut: 0, tokensCache: 0 }),
      mk({ sessionId: "b", model: "claude-opus-4-8", tokensIn: 100, tokensOut: 0, tokensCache: 0 }),
      mk({ sessionId: "c", agent: "codex", model: "gpt-5.5", tokensIn: 50, tokensOut: 0, tokensCache: 0 }),
    ], "all", NOW);
    const opus = p.models.find((m) => m.model === "claude-opus-4-8")!;
    expect(opus.sessions).toBe(2);
    expect(opus.tokens).toBe(200);
  });

  it("7d and 30d ranges filter sessions by recency boundary", () => {
    // DAY_MS = 86_400_000; NOW = Date.parse("2026-06-28T12:00:00.000Z")
    const nearEnd = NOW - 3 * 86_400_000;   // 3 days ago  → inside 7d AND 30d
    const midEnd  = NOW - 10 * 86_400_000;  // 10 days ago → outside 7d, inside 30d
    const farEnd  = NOW - 40 * 86_400_000;  // 40 days ago → outside both
    const stats = [
      mk({ sessionId: "near", startMs: nearEnd - 60_000, endMs: nearEnd }),
      mk({ sessionId: "mid",  startMs: midEnd  - 60_000, endMs: midEnd  }),
      mk({ sessionId: "far",  startMs: farEnd  - 60_000, endMs: farEnd  }),
    ];
    const r7 = aggregateObserve(stats, "7d", NOW);
    expect(r7.pulse.sessions).toBe(1);
    expect(r7.sessions.map((s) => s.sessionId)).toEqual(["near"]);

    const r30 = aggregateObserve(stats, "30d", NOW);
    expect(r30.pulse.sessions).toBe(2);
    expect(r30.sessions.map((s) => s.sessionId).sort()).toEqual(["mid", "near"]);
  });

  it("sessions sorted by endMs desc; daily by date asc; models by tokens desc", () => {
    const D1 = Date.parse("2026-06-26T10:00:00.000Z");
    const D2 = Date.parse("2026-06-27T10:00:00.000Z");
    const D3 = Date.parse("2026-06-28T10:00:00.000Z");
    const stats = [
      mk({ sessionId: "c3", model: "big",   startMs: D3, endMs: D3 + 60_000, tokensIn: 300, tokensOut: 0, tokensCache: 0 }),
      mk({ sessionId: "a1", model: "small",  startMs: D1, endMs: D1 + 60_000, tokensIn: 50,  tokensOut: 0, tokensCache: 0 }),
      mk({ sessionId: "b2", model: "big",   startMs: D2, endMs: D2 + 60_000, tokensIn: 100, tokensOut: 0, tokensCache: 0 }),
    ];
    const p = aggregateObserve(stats, "all", NOW);
    // sessions: endMs desc → c3 (D3+60k), b2 (D2+60k), a1 (D1+60k)
    expect(p.sessions.map((s) => s.sessionId)).toEqual(["c3", "b2", "a1"]);
    // daily: date asc → 2026-06-26, 2026-06-27, 2026-06-28
    expect(p.daily.map((d) => d.date)).toEqual(["2026-06-26", "2026-06-27", "2026-06-28"]);
    // models: tokens desc → big (300+100=400), small (50)
    expect(p.models.map((m) => m.model)).toEqual(["big", "small"]);
    expect(p.models[0].tokens).toBe(400);
    expect(p.models[1].tokens).toBe(50);
  });

  it("session rows carry startMs, tokensIn/Out/Cache, gitBranch", () => {
    const s = mk({ sessionId: "detail", gitBranch: "feat/y", tokensIn: 111, tokensOut: 22, tokensCache: 33 });
    const p = aggregateObserve([s], "all", NOW);
    const row = p.sessions[0]!;
    expect(row.startMs).toBe(s.startMs);
    expect(row.tokensIn).toBe(111);
    expect(row.tokensOut).toBe(22);
    expect(row.tokensCache).toBe(33);
    expect(row.gitBranch).toBe("feat/y");
  });
});

describe("aggregateObserve filters", () => {
  const NOW = Date.parse("2026-06-28T12:00:00.000Z");
  // 2 agents × 2 projects × 2 models
  const stats: SessionStat[] = [
    mk({ sessionId: "c-a-m1", agent: "claude", project: "proj-a", model: "m1", msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 0 }),
    mk({ sessionId: "c-b-m2", agent: "claude", project: "proj-b", model: "m2", msgs: 2, tokensIn: 20, tokensOut: 8, tokensCache: 0 }),
    mk({ sessionId: "x-a-m1", agent: "codex",  project: "proj-a", model: "m1", msgs: 3, tokensIn: 30, tokensOut: 10, tokensCache: 0 }),
    mk({ sessionId: "x-b-m2", agent: "codex",  project: "proj-b", model: "m2", msgs: 1, tokensIn: 40, tokensOut: 12, tokensCache: 0 }),
  ];

  it("filter.agent keeps only that agent", () => {
    const p = aggregateObserve(stats, "all", NOW, { agent: "codex" });
    expect(p.sessions.map((s) => s.sessionId).sort()).toEqual(["x-a-m1", "x-b-m2"]);
    expect(p.pulse.sessions).toBe(2);
  });

  it("filter.project keeps only that project", () => {
    const p = aggregateObserve(stats, "all", NOW, { project: "proj-a" });
    expect(p.sessions.map((s) => s.sessionId).sort()).toEqual(["c-a-m1", "x-a-m1"]);
    expect(p.pulse.sessions).toBe(2);
  });

  it("filter.model keeps only that model", () => {
    const p = aggregateObserve(stats, "all", NOW, { model: "m2" });
    expect(p.sessions.map((s) => s.sessionId).sort()).toEqual(["c-b-m2", "x-b-m2"]);
  });

  it("filter.minMsgs drops sessions below the threshold", () => {
    const p = aggregateObserve(stats, "all", NOW, { minMsgs: 3 });
    // msgs: c-a-m1=5, c-b-m2=2, x-a-m1=3, x-b-m2=1 → keep 5 and 3
    expect(p.sessions.map((s) => s.sessionId).sort()).toEqual(["c-a-m1", "x-a-m1"]);
  });

  it("facets are computed PRE-filter: filtering by agent still shows all agents in facets", () => {
    const p = aggregateObserve(stats, "all", NOW, { agent: "codex" });
    // Only codex sessions remain in pulse/daily/sessions, but facets show both
    expect(p.facets.agents.sort()).toEqual(["claude", "codex"]);
    expect(p.facets.projects.sort()).toEqual(["proj-a", "proj-b"]);
    expect(p.facets.models.sort()).toEqual(["m1", "m2"]);
    // filtered view only contains codex sessions
    expect(p.pulse.sessions).toBe(2);
  });
});

describe("parseClaudeTranscript gitBranch", () => {
  it("captures gitBranch from a record carrying it", () => {
    const s = parseClaudeTranscript(join(claudeDir, "projects", "proj-a", "s-branch.jsonl"))!;
    expect(s).not.toBeNull();
    expect(s.gitBranch).toBe("feat/x");
  });

  it("codex transcript always has gitBranch null", () => {
    const s = parseCodexTranscript(join(codexDir, "sessions", "2026", "06", "28", "rollout-x1.jsonl"))!;
    expect(s).not.toBeNull();
    expect(s.gitBranch).toBeNull();
  });
});

describe("scanSessionsCached", () => {
  beforeEach(() => clearScanCache());

  it("returns the same array reference on second call within TTL", () => {
    const nowMs = Date.now();
    const first = scanSessionsCached(nowMs, { claudeDir, codexDir });
    const second = scanSessionsCached(nowMs + 1_000, { claudeDir, codexDir }); // +1s < 15s TTL
    expect(second).toBe(first);
  });

  it("re-scans when nowMs exceeds TTL", () => {
    const nowMs = Date.now();
    const first = scanSessionsCached(nowMs, { claudeDir, codexDir });
    const second = scanSessionsCached(nowMs + 20_000, { claudeDir, codexDir }); // +20s > 15s TTL
    expect(second).not.toBe(first);
  });

  it("re-scans after clearScanCache()", () => {
    const nowMs = Date.now();
    const first = scanSessionsCached(nowMs, { claudeDir, codexDir });
    clearScanCache();
    const second = scanSessionsCached(nowMs + 100, { claudeDir, codexDir }); // same ts, but cache cleared
    expect(second).not.toBe(first);
  });
});
