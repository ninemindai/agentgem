# Observe Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left-rail **Observe** console panel that charts the user's local agent-session activity (daily activity, token usage, session length, model mix) across Claude Code and Codex.

**Architecture:** A new backend module `observeScan.ts` walks both transcript stores and normalizes every session into one `SessionStat` shape, then aggregates into a compact `ObservePayload` bucketed by a time range. A `GET /api/observe` controller method serves it (mirroring `/api/usage`). A new `Observe` React panel fetches it and renders Recharts charts plus a sortable session table.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node `fs`, `@agentback/openapi` controller decorators, Zod, React 19, **Recharts** (new dep), Vitest.

## Global Constraints

- ESM throughout; all relative imports use the `.js` extension (compiled-dist test setup — `npm test` runs `tsc -b && vitest run`).
- Privacy boundary: parsers read `usage`, `timestamp`, `model`, `type`, `cwd`/`id` only — NEVER message text. Same boundary `workflowScan.ts` holds.
- Total functions on the read path: missing/unreadable dirs and malformed JSONL lines degrade to empty/skip, never throw.
- No new backend dependencies. One new frontend dependency: `recharts` in `packages/console`.
- Home dirs come from `resolveDirs(dir?)` in `src/resolveDir.ts` → `{ claudeDir, codexDir }`; the optional `dir` override is the test seam (defaults to `~/.claude`, `~/.codex`).
- Token normalization is identical across agents: `tokensIn` = fresh input (excludes cache), `tokensCache` = cached/cache-read+creation, `tokensOut` = output (+ reasoning for Codex).

---

### Task 1: `observeScan` — parse + normalize transcripts → `SessionStat[]`

**Files:**
- Create: `src/gem/observeScan.ts`
- Create: `src/gem/__tests__/observeScan.test.ts`
- Reference: `src/resolveDir.ts` (for `resolveDirs`), `src/gem/workflowScan.ts` (privacy/parse style)

**Interfaces:**
- Produces:
  - `interface SessionStat { agent: "claude" | "codex"; sessionId: string; project: string | null; model: string | null; startMs: number; endMs: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number }`
  - `function scanSessions(dirs?: { claudeDir?: string; codexDir?: string }): SessionStat[]`
  - `function parseClaudeTranscript(path: string): SessionStat | null`
  - `function parseCodexTranscript(path: string): SessionStat | null`

- [ ] **Step 1: Write failing tests with real-shaped fixtures**

Create `src/gem/__tests__/observeScan.test.ts`. The tests write tiny JSONL fixtures to a temp dir and assert the normalized output. Note: `tokensIn` excludes cache for both agents.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions, parseClaudeTranscript, parseCodexTranscript, type SessionStat } from "../observeScan.js";

let home: string, claudeDir: string, codexDir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "observe-"));
  claudeDir = join(home, ".claude");
  codexDir = join(home, ".codex");
  // Claude: ~/.claude/projects/<folder>/<session>.jsonl
  const cproj = join(claudeDir, "projects", "proj-a");
  mkdirSync(cproj, { recursive: true });
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
    expect(stats.map((s) => s.sessionId).sort()).toEqual(["s1", "x1"]);
    const missing = scanSessions({ claudeDir, codexDir: join(home, "nope") });
    expect(missing.map((s) => s.sessionId)).toEqual(["s1"]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- observeScan`
Expected: FAIL — `Cannot find module '../observeScan.js'`.

- [ ] **Step 3: Implement `observeScan.ts`**

```ts
// src/gem/observeScan.ts
//
// Deterministic transcript → SessionStat. Walks the local Claude + Codex session
// stores and normalizes each session into one usage/timing record. Privacy
// boundary: reads usage, timestamps, model, type, cwd/id ONLY — never message
// text (mirrors workflowScan.ts). Total functions: missing dirs / malformed
// lines degrade to empty/skip, never throw.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveDirs } from "../resolveDir.js";

export interface SessionStat {
  agent: "claude" | "codex";
  sessionId: string;
  project: string | null;   // basename of session cwd, or null
  model: string | null;
  startMs: number;
  endMs: number;
  msgs: number;
  tokensIn: number;         // fresh input (cache excluded)
  tokensOut: number;        // output (+ reasoning for codex)
  tokensCache: number;      // cache read+creation (claude) / cached_input (codex)
}

function* jsonLines(path: string): Generator<Record<string, unknown>> {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* skip malformed */ }
  }
}

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, suffix));
    else if (e.name.endsWith(suffix)) out.push(p);
  }
  return out;
}

export function parseClaudeTranscript(path: string): SessionStat | null {
  let sessionId = "", cwd: string | null = null, model: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const rec of jsonLines(path)) {
    const type = rec.type as string | undefined;
    if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    if (type === "user" || type === "assistant") msgs++;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.model === "string") model = msg.model;
    const u = msg?.usage as Record<string, number> | undefined;
    if (u) {
      tokensIn += u.input_tokens ?? 0;
      tokensOut += u.output_tokens ?? 0;
      tokensCache += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  if (!sessionId || endMs < startMs) return null;
  return { agent: "claude", sessionId, project: cwd ? basename(cwd) : null, model, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache };
}

export function parseCodexTranscript(path: string): SessionStat | null {
  let sessionId = "", cwd: string | null = null, model: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
  let total: Record<string, number> | null = null;   // cumulative; keep the last seen
  for (const rec of jsonLines(path)) {
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (rec.type === "session_meta" && payload) {
      if (typeof payload.id === "string") sessionId = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
    }
    if (payload && typeof payload.model === "string") model = payload.model;     // best-effort (turn_context)
    if (rec.type === "response_item" && (payload?.type === "message")) msgs++;
    if (rec.type === "event_msg" && payload?.type === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined;
      const tu = info?.total_token_usage as Record<string, number> | undefined;
      if (tu) total = tu;
    }
  }
  if (!sessionId || endMs < startMs) return null;
  const input = total?.input_tokens ?? 0, cached = total?.cached_input_tokens ?? 0;
  const tokensIn = Math.max(0, input - cached);
  const tokensOut = (total?.output_tokens ?? 0) + (total?.reasoning_output_tokens ?? 0);
  return { agent: "codex", sessionId, project: cwd ? basename(cwd) : null, model, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache: cached };
}

export function scanSessions(dirs?: { claudeDir?: string; codexDir?: string }): SessionStat[] {
  const resolved = resolveDirs();
  const claudeDir = dirs?.claudeDir ?? resolved.claudeDir;
  const codexDir = dirs?.codexDir ?? resolved.codexDir;
  const out: SessionStat[] = [];
  for (const f of listFiles(join(claudeDir, "projects"), ".jsonl")) {
    const s = parseClaudeTranscript(f); if (s) out.push(s);
  }
  for (const f of listFiles(join(codexDir, "sessions"), ".jsonl")) {
    if (!basename(f).startsWith("rollout-")) continue;   // skip history.jsonl etc.
    const s = parseCodexTranscript(f); if (s) out.push(s);
  }
  return out;
}
```

Note: `statSync` import is unused above — remove it if your linter flags it; kept here only if you add a size guard.

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- observeScan`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/observeScan.ts src/gem/__tests__/observeScan.test.ts
git commit -m "feat(observe): transcript scan → normalized SessionStat (claude + codex)"
```

---

### Task 2: `aggregateObserve` — `SessionStat[]` → `ObservePayload`

**Files:**
- Modify: `src/gem/observeScan.ts` (add aggregation + types)
- Modify: `src/gem/__tests__/observeScan.test.ts` (add aggregation tests)

**Interfaces:**
- Consumes: `SessionStat` (Task 1)
- Produces:
  - `type ObserveRange = "today" | "7d" | "30d" | "all"`
  - `interface ObservePayload { pulse: { sessions: number; msgs: number; tokens: number; activeMs: number }; daily: { date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number }[]; sessions: { agent: "claude" | "codex"; sessionId: string; project: string | null; model: string | null; durationMs: number; msgs: number; tokens: number; endMs: number }[]; models: { model: string; agent: "claude" | "codex"; sessions: number; tokens: number }[]; range: ObserveRange }`
  - `function aggregateObserve(stats: SessionStat[], range: ObserveRange, nowMs: number): ObservePayload`

- [ ] **Step 1: Write failing aggregation tests**

Append to `src/gem/__tests__/observeScan.test.ts`:

```ts
import { aggregateObserve, type ObservePayload } from "../observeScan.js";

const mk = (over: Partial<SessionStat>): SessionStat => ({
  agent: "claude", sessionId: "s", project: "app", model: "claude-opus-4-8",
  startMs: 0, endMs: 60_000, msgs: 4, tokensIn: 100, tokensOut: 40, tokensCache: 10, ...over,
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
    expect(d28.tokensIn).toBe(300);
    expect(p.daily.map((d) => d.date)).toContain("2026-06-27");
  });

  it("pulse sums the range; range filters by recency", () => {
    const recent = day("2026-06-28T09:00:00.000Z", { sessionId: "r" });
    const old = day("2026-05-01T09:00:00.000Z", { sessionId: "o" });
    const today = aggregateObserve([recent, old], "today", NOW);
    expect(today.sessions.map((s) => s.sessionId)).toEqual(["r"]);
    expect(today.pulse.sessions).toBe(1);
    const all = aggregateObserve([recent, old], "all", NOW);
    expect(all.pulse.sessions).toBe(2);
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
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- observeScan`
Expected: FAIL — `aggregateObserve` not exported.

- [ ] **Step 3: Implement aggregation in `observeScan.ts`**

Append to `src/gem/observeScan.ts`:

```ts
export type ObserveRange = "today" | "7d" | "30d" | "all";

export interface ObservePayload {
  pulse: { sessions: number; msgs: number; tokens: number; activeMs: number };
  daily: { date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number }[];
  sessions: { agent: "claude" | "codex"; sessionId: string; project: string | null; model: string | null; durationMs: number; msgs: number; tokens: number; endMs: number }[];
  models: { model: string; agent: "claude" | "codex"; sessions: number; tokens: number }[];
  range: ObserveRange;
}

const DAY_MS = 86_400_000;
const tokensOf = (s: SessionStat) => s.tokensIn + s.tokensOut + s.tokensCache;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function sinceMs(range: ObserveRange, nowMs: number): number {
  if (range === "all") return -Infinity;
  if (range === "today") return Date.parse(utcDate(nowMs) + "T00:00:00.000Z");
  return nowMs - (range === "7d" ? 7 : 30) * DAY_MS;
}

export function aggregateObserve(stats: SessionStat[], range: ObserveRange, nowMs: number): ObservePayload {
  const since = sinceMs(range, nowMs);
  const inRange = stats.filter((s) => s.endMs >= since);

  const byDay = new Map<string, ObservePayload["daily"][number]>();
  const byModel = new Map<string, ObservePayload["models"][number]>();
  let pTokens = 0, pMsgs = 0, pActive = 0;
  for (const s of inRange) {
    const date = utcDate(s.startMs);
    const d = byDay.get(date) ?? { date, sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    d.sessions++; d.msgs += s.msgs; d.tokensIn += s.tokensIn; d.tokensOut += s.tokensOut; d.tokensCache += s.tokensCache;
    byDay.set(date, d);

    const mk = `${s.agent} ${s.model ?? "unknown"}`;
    const m = byModel.get(mk) ?? { model: s.model ?? "unknown", agent: s.agent, sessions: 0, tokens: 0 };
    m.sessions++; m.tokens += tokensOf(s);
    byModel.set(mk, m);

    pTokens += tokensOf(s); pMsgs += s.msgs; pActive += Math.max(0, s.endMs - s.startMs);
  }

  return {
    pulse: { sessions: inRange.length, msgs: pMsgs, tokens: pTokens, activeMs: pActive },
    daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: inRange
      .map((s) => ({ agent: s.agent, sessionId: s.sessionId, project: s.project, model: s.model, durationMs: Math.max(0, s.endMs - s.startMs), msgs: s.msgs, tokens: tokensOf(s), endMs: s.endMs }))
      .sort((a, b) => b.endMs - a.endMs)
      .slice(0, 200),
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    range,
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- observeScan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/observeScan.ts src/gem/__tests__/observeScan.test.ts
git commit -m "feat(observe): aggregate SessionStat[] → ranged ObservePayload"
```

---

### Task 3: `GET /api/observe` controller endpoint

**Files:**
- Modify: `src/gem.controller.ts` (add schema + `@get("/observe")` method)
- Create: `src/__tests__/observe.controller.test.ts`

**Interfaces:**
- Consumes: `scanSessions`, `aggregateObserve`, `ObservePayload` (Tasks 1–2)
- Produces: HTTP `GET /api/observe?range=today|7d|30d|all` → `ObservePayload` JSON.

- [ ] **Step 1: Write the failing controller test**

Create `src/__tests__/observe.controller.test.ts`. The controller method is a thin pass-through; the test calls it directly with a query and asserts it returns a well-formed payload from the real local store (or empty without throwing).

```ts
import { describe, it, expect } from "vitest";
import { GemController } from "../gem.controller.js";

describe("GemController.observe", () => {
  it("returns an ObservePayload for a valid range without throwing", async () => {
    const c = new GemController();
    const out = await c.observe({ query: { range: "all" } });
    expect(out.range).toBe("all");
    expect(Array.isArray(out.daily)).toBe(true);
    expect(Array.isArray(out.sessions)).toBe(true);
    expect(Array.isArray(out.models)).toBe(true);
    expect(typeof out.pulse.sessions).toBe("number");
  });

  it("defaults to 7d when range is omitted", async () => {
    const c = new GemController();
    const out = await c.observe({ query: {} });
    expect(out.range).toBe("7d");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- observe.controller`
Expected: FAIL — `c.observe is not a function`.

- [ ] **Step 3: Add the schema + handler to `gem.controller.ts`**

Near the other Zod schema imports/definitions at the top of `src/gem.controller.ts`, add:

```ts
import { scanSessions, aggregateObserve } from "./gem/observeScan.js";

const ObserveQuerySchema = z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional() });
const ObservePayloadSchema = z.object({
  pulse: z.object({ sessions: z.number(), msgs: z.number(), tokens: z.number(), activeMs: z.number() }),
  daily: z.array(z.object({ date: z.string(), sessions: z.number(), msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })),
  sessions: z.array(z.object({ agent: z.enum(["claude", "codex"]), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), durationMs: z.number(), msgs: z.number(), tokens: z.number(), endMs: z.number() })),
  models: z.array(z.object({ model: z.string(), agent: z.enum(["claude", "codex"]), sessions: z.number(), tokens: z.number() })),
  range: z.enum(["today", "7d", "30d", "all"]),
});
```

Inside the `GemController` class (next to the `usage` method), add:

```ts
  @get("/observe", { query: ObserveQuerySchema, response: ObservePayloadSchema })
  async observe(input: { query: z.infer<typeof ObserveQuerySchema> }): Promise<z.infer<typeof ObservePayloadSchema>> {
    const range = input.query.range ?? "7d";
    return aggregateObserve(scanSessions(), range, Date.now());
  }
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- observe.controller`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/__tests__/observe.controller.test.ts
git commit -m "feat(observe): GET /api/observe endpoint (ranged payload)"
```

---

### Task 4: `observe` nav group plumbing

**Files:**
- Modify: `packages/console/src/contract.ts` (widen the `group` union)
- Modify: `packages/console/src/registry.ts` (add `observe` bucket to `groupedPages`)
- Modify: `packages/console/src/shell/Shell.tsx` (render the group)
- Create: `packages/console/src/__tests__/observeGroup.test.ts`

**Interfaces:**
- Consumes: `ConsolePage`, `groupedPages` (existing)
- Produces: `groupedPages(pages).observe` bucket; Shell renders an "Observe" label + its items above Build.

- [ ] **Step 1: Write the failing grouping test**

Create `packages/console/src/__tests__/observeGroup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupedPages } from "../registry.js";
import { defineConsolePage } from "../contract.js";

describe("groupedPages observe bucket", () => {
  it("collects pages with group 'observe'", () => {
    const page = defineConsolePage({ id: "observe", title: "Observe", order: 5, group: "observe", route: "#/observe", component: () => null });
    const g = groupedPages([page]);
    expect(g.observe.map((p) => p.id)).toEqual(["observe"]);
    expect(g.build).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/console && npx vitest run observeGroup`
Expected: FAIL — `group: "observe"` rejected by the union type, and `g.observe` is undefined.

- [ ] **Step 3: Widen the union in `contract.ts`**

In `packages/console/src/contract.ts`, change the `group` field of `ConsolePage`:

```ts
  /** Sidebar group; defaults to "build". */
  group?: "observe" | "build" | "library" | "settings";
```

- [ ] **Step 4: Add the bucket in `registry.ts`**

In `packages/console/src/registry.ts`, inside the object returned by `groupedPages`, add the `observe` line (before `build`):

```ts
    observe: ordered.filter((p) => p.group === "observe"),
    build: ordered.filter((p) => (p.group ?? "build") === "build"),
    library: ordered.filter((p) => p.group === "library"),
    settings: ordered.filter((p) => p.group === "settings"),
```

Also update the function's return type annotation if it lists keys explicitly — add `observe: ConsolePage[]` to it.

- [ ] **Step 5: Render the group in `Shell.tsx`**

In `packages/console/src/shell/Shell.tsx`, immediately before the `Build` label block (around line 41), add:

```tsx
        {groups.observe.length > 0 && <div className="console-group-label">Observe</div>}
        {groups.observe.map(item)}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `cd packages/console && npx vitest run observeGroup`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/contract.ts packages/console/src/registry.ts packages/console/src/shell/Shell.tsx packages/console/src/__tests__/observeGroup.test.ts
git commit -m "feat(observe): add 'observe' sidebar group above Build"
```

---

### Task 5: client `observeRoute` + `data.ts` chart transforms

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `observeRoute` + schema + types)
- Create: `packages/console/src/panels/Observe/data.ts`
- Create: `packages/console/src/panels/Observe/data.test.ts`

**Interfaces:**
- Consumes: `defineRoute` (existing), `ObservePayload` shape (Task 2/3)
- Produces:
  - `observeRoute` (GET `/api/observe`), `type ObservePayload`, `type ObserveRange`, `type SessionRow`, `type DailyPoint`, `type ModelSlice`
  - `function fmtTokens(n: number): string` — "1.2M" / "950k" / "300"
  - `function fmtDuration(ms: number): string` — "2.1h" / "47m" / "30s"
  - `function tokenSeries(daily: DailyPoint[]): { date: string; in: number; out: number; cache: number }[]`

- [ ] **Step 1: Write failing transform tests**

Create `packages/console/src/panels/Observe/data.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fmtTokens, fmtDuration, tokenSeries } from "./data.js";

describe("formatters", () => {
  it("fmtTokens scales", () => {
    expect(fmtTokens(300)).toBe("300");
    expect(fmtTokens(950_00)).toBe("95k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
  });
  it("fmtDuration scales", () => {
    expect(fmtDuration(30_000)).toBe("30s");
    expect(fmtDuration(47 * 60_000)).toBe("47m");
    expect(fmtDuration(Math.round(2.1 * 3_600_000))).toBe("2.1h");
  });
  it("tokenSeries maps daily points to short keys", () => {
    expect(tokenSeries([{ date: "2026-06-28", sessions: 1, msgs: 4, tokensIn: 100, tokensOut: 40, tokensCache: 10 }]))
      .toEqual([{ date: "2026-06-28", in: 100, out: 40, cache: 10 }]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/console && npx vitest run panels/Observe/data`
Expected: FAIL — `Cannot find module './data.js'`.

- [ ] **Step 3: Add `observeRoute` to `routes.ts`**

In `packages/console/src/api/routes.ts`, near the other route definitions, add:

```ts
const ObservePayloadSchema = z.object({
  pulse: z.object({ sessions: z.number(), msgs: z.number(), tokens: z.number(), activeMs: z.number() }),
  daily: z.array(z.object({ date: z.string(), sessions: z.number(), msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })),
  sessions: z.array(z.object({ agent: z.enum(["claude", "codex"]), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), durationMs: z.number(), msgs: z.number(), tokens: z.number(), endMs: z.number() })),
  models: z.array(z.object({ model: z.string(), agent: z.enum(["claude", "codex"]), sessions: z.number(), tokens: z.number() })),
  range: z.enum(["today", "7d", "30d", "all"]),
});
export type ObservePayload = z.infer<typeof ObservePayloadSchema>;
export type ObserveRange = ObservePayload["range"];
export type SessionRow = ObservePayload["sessions"][number];
export type DailyPoint = ObservePayload["daily"][number];
export type ModelSlice = ObservePayload["models"][number];

export const observeRoute = defineRoute("GET", "/api/observe", {
  query: z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional() }),
  response: ObservePayloadSchema,
});
```

- [ ] **Step 4: Implement `data.ts`**

```ts
// packages/console/src/panels/Observe/data.ts
import type { DailyPoint } from "../../api/routes.js";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s >= 3600) return (s / 3600).toFixed(1).replace(/\.0$/, "") + "h";
  if (s >= 60) return Math.round(s / 60) + "m";
  return Math.round(s) + "s";
}

export function tokenSeries(daily: DailyPoint[]): { date: string; in: number; out: number; cache: number }[] {
  return daily.map((d) => ({ date: d.date, in: d.tokensIn, out: d.tokensOut, cache: d.tokensCache }));
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd packages/console && npx vitest run panels/Observe/data`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Observe/data.ts packages/console/src/panels/Observe/data.test.ts
git commit -m "feat(observe): client observeRoute contract + chart transforms"
```

---

### Task 6: Observe panel UI (Recharts) + registration

**Files:**
- Modify: `packages/console/package.json` (add `recharts`)
- Create: `packages/console/src/panels/Observe/Dashboard.tsx`
- Create: `packages/console/src/panels/Observe/index.tsx`
- Create: `packages/console/src/panels/Observe/Observe.test.tsx`
- Modify: `packages/console/src/pages.tsx` (register `observePage`)

**Interfaces:**
- Consumes: `observeRoute`, `makeClient`, `ObservePayload`, `ObserveRange`, `fmtTokens`, `fmtDuration`, `tokenSeries`, `defineConsolePage`
- Produces: `observePage` (ConsolePage), `<Observe apiBase>`, `<Dashboard data range onRange>`

- [ ] **Step 1: Add the recharts dependency**

```bash
cd packages/console && npm install recharts@^2.13.0
```

Confirm `recharts` now appears under `dependencies` in `packages/console/package.json`.

- [ ] **Step 2: Write the failing panel test**

Create `packages/console/src/panels/Observe/Observe.test.tsx`. Recharts uses ResponsiveContainer (needs layout); the test asserts the pulse + table render from injected data, so it renders `<Dashboard>` directly with a fixed payload (no network, no chart-size dependency).

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "./Dashboard.js";
import type { ObservePayload } from "../../api/routes.js";

const payload: ObservePayload = {
  pulse: { sessions: 2, msgs: 12, tokens: 1_200_000, activeMs: 2.1 * 3_600_000 },
  daily: [{ date: "2026-06-28", sessions: 2, msgs: 12, tokensIn: 800_000, tokensOut: 300_000, tokensCache: 100_000 }],
  sessions: [{ agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8", durationMs: 2.1 * 3_600_000, msgs: 8, tokens: 900_000, endMs: 0 }],
  models: [{ model: "claude-opus-4-8", agent: "claude", sessions: 2, tokens: 1_200_000 }],
  range: "7d",
};

describe("Observe Dashboard", () => {
  it("renders the pulse and a session row", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} />);
    expect(screen.getByText("1.2M")).toBeDefined();       // pulse tokens
    expect(screen.getByText("agentgem")).toBeDefined();    // session row project
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd packages/console && npx vitest run panels/Observe/Observe`
Expected: FAIL — `Cannot find module './Dashboard.js'`.

- [ ] **Step 4: Implement `Dashboard.tsx`**

```tsx
// packages/console/src/panels/Observe/Dashboard.tsx
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import type { ObservePayload, ObserveRange } from "../../api/routes.js";
import { fmtTokens, fmtDuration, tokenSeries } from "./data.js";

const RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];
const RANGE_LABEL: Record<ObserveRange, string> = { today: "Today", "7d": "7d", "30d": "30d", all: "All" };
const SLICE_COLORS = ["var(--accent)", "var(--emerald, #34d399)", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

export function Dashboard({ data, range, onRange }: { data: ObservePayload; range: ObserveRange; onRange: (r: ObserveRange) => void }) {
  const empty = data.pulse.sessions === 0;
  return (
    <div className="obs">
      <div className="obs-head">
        <h2 className="obs-title">Observe</h2>
        <div className="obs-range" role="tablist" aria-label="time range">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={r === range}
              className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="obs-pulse">
        <Stat label="sessions" value={String(data.pulse.sessions)} />
        <Stat label="messages" value={String(data.pulse.msgs)} />
        <Stat label="tokens" value={fmtTokens(data.pulse.tokens)} />
        <Stat label="active" value={fmtDuration(data.pulse.activeMs)} />
      </div>

      {empty ? (
        <p className="obs-empty">No agent sessions found yet for this range.</p>
      ) : (
        <>
          <div className="obs-charts">
            <Card title="Activity (sessions/day)">
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={data.daily}>
                  <CartesianGrid strokeOpacity={0.1} vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={28} />
                  <Tooltip />
                  <Bar dataKey="sessions" fill="var(--accent)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Tokens (in / out / cache)">
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={tokenSeries(data.daily)}>
                  <CartesianGrid strokeOpacity={0.1} vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={36} tickFormatter={fmtTokens} />
                  <Tooltip formatter={(v: number) => fmtTokens(v)} />
                  <Area dataKey="in" stackId="t" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.5} />
                  <Area dataKey="out" stackId="t" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.5} />
                  <Area dataKey="cache" stackId="t" stroke="#64748b" fill="#64748b" fillOpacity={0.4} />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card title="By model">
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={data.models} dataKey="tokens" nameKey="model" innerRadius={36} outerRadius={60} paddingAngle={2}>
                    {data.models.map((_, i) => <Cell key={i} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtTokens(v)} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="obs-legend">
                {data.models.map((m, i) => (
                  <li key={m.agent + m.model}>
                    <span className="obs-dot" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                    {m.model} <span className="obs-muted">({m.sessions})</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="obs-table-wrap">
            <table className="obs-table">
              <thead><tr><th>project</th><th>agent</th><th>model</th><th>dur</th><th>msgs</th><th>tokens</th></tr></thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.agent + s.sessionId}>
                    <td>{s.project ?? "—"}</td>
                    <td><span className="obs-chip">{s.agent}</span></td>
                    <td className="obs-muted">{s.model ?? "—"}</td>
                    <td>{fmtDuration(s.durationMs)}</td>
                    <td>{s.msgs}</td>
                    <td>{fmtTokens(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="obs-stat"><div className="obs-stat-value">{value}</div><div className="obs-stat-label">{label}</div></div>;
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="obs-card"><div className="obs-card-title">{title}</div>{children}</div>;
}
```

- [ ] **Step 5: Implement `index.tsx` (page + fetch)**

```tsx
// packages/console/src/panels/Observe/index.tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRoute, makeClient, type ObservePayload, type ObserveRange } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";

export function Observe({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<ObservePayload | null>(null);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    observeRoute.call(makeClient(apiBase), { query: { range } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase, range]);

  if (error) return <div className="obs"><p className="obs-error">Couldn't load Observe: {error}</p></div>;
  if (!data) return <div className="obs"><p className="obs-loading">Loading…</p></div>;
  return <Dashboard data={data} range={range} onRange={setRange} />;
}

export const observePage = defineConsolePage({
  id: "observe", title: "Observe", icon: "👁", order: 5, group: "observe",
  route: "#/observe", component: Observe,
});
```

- [ ] **Step 6: Register the page in `pages.tsx`**

In `packages/console/src/pages.tsx` add the import and array entry:

```tsx
import { observePage } from "./panels/Observe/index.js";
```

and add `observePage` to the front of the `pages` array:

```tsx
export const pages: ConsolePage[] = [observePage, curatePage, materializePage, workspacesPage, getGemsPage, settingsPage, receivedPage, deployPage];
```

- [ ] **Step 7: Run the panel test, verify pass**

Run: `cd packages/console && npx vitest run panels/Observe/Observe`
Expected: PASS.

- [ ] **Step 8: Full build + test to catch wiring/type regressions**

Run (from repo root): `npm test`
Expected: PASS (`tsc -b` clean, all suites green). If `tsc` flags a stale dist after the new files, run `rm -rf dist && npm test`.

- [ ] **Step 9: Add Observe styles**

Append the panel styles to the console stylesheet (find the file the other panels' classes live in — search `grep -rl "console-group-label" packages/console`). Add minimal rules for `.obs`, `.obs-head`, `.obs-range`, `.obs-pulse`, `.obs-stat`, `.obs-charts`, `.obs-card`, `.obs-table`, `.obs-empty`, `.obs-error`, `.obs-legend`, `.obs-chip` consistent with existing panels (reuse `var(--accent)` etc.). Keep it small; match the existing visual language.

- [ ] **Step 10: Commit**

```bash
git add packages/console/package.json packages/console/package-lock.json packages/console/src/panels/Observe packages/console/src/pages.tsx
git add -A   # include stylesheet change
git commit -m "feat(observe): Observe panel — Recharts dashboard + session table"
```

---

### Task 7: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Build and run the app**

Run: `npm run build && node dist/index.js` (or the project's start command — check `package.json` "scripts").
Open the printed UI URL.

- [ ] **Step 2: Verify the panel**

- "Observe" appears at the top of the left rail (above Build) with the 👁 icon.
- Pulse shows non-zero numbers (you have local sessions).
- Activity + token charts render; model donut shows your models.
- Session table lists recent sessions, sorted by recency.
- Switching range (Today/7d/30d/All) refetches and re-scopes every widget.

- [ ] **Step 3: Verify the privacy boundary**

Run: `curl -s "$URL/api/observe?range=all" | head -c 2000`
Confirm the payload contains only counts/timestamps/model/project — **no message text**.

---

## Notes for the implementer

- The two transcript formats are genuinely different; Task 1's fixtures encode the real shapes (Claude per-message `message.usage`; Codex cumulative `event_msg.payload.info.total_token_usage`). Don't unify the parsers — the normalized `SessionStat` is the unification point.
- Codex `total_token_usage` is **cumulative**, so the parser keeps the LAST token_count record, not a sum.
- `tokensIn` excludes cache for BOTH agents (Codex `input_tokens` includes cached, so subtract; Claude `input_tokens` is already fresh).
- Recharts `ResponsiveContainer` renders 0×0 in jsdom — that's why the panel test renders `<Dashboard>` with injected data and asserts the pulse/table (DOM), not chart geometry.
