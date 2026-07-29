# Engaged-Time Metric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview "active" stat (a per-session wall-clock span sum that reaches >24h/day) with per-session *engaged* time — the sum of consecutive-record gaps, each capped at 5 minutes so idle stretches are stripped.

**Architecture:** A pure helper `engagedMsFromTimestamps` lives in `observeAggregate.ts` (browser-shareable, unit-tested). The two `observeScan.ts` transcript parsers collect each record's timestamp and store `engagedMs` on `SessionStat` (a new *optional* field). Both consumers — the Observe pulse (`aggregateObserve`) and the Home/Reveal ledger (`home.controller.ts`) — sum `s.engagedMs ?? span`, so foreign-source sessions that don't yet populate it fall back to the old span. Two cache-version bumps stop stale field-less records being served.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, pnpm workspaces, React (console).

## Global Constraints

- `engagedMs` is an **optional** field on `SessionStat` (`engagedMs?: number`), matching the interface's existing optional-field convention. Never make it required — foreign source parsers (`sources/*.ts`) are intentionally left on the span fallback for now.
- The gap cap is exactly `ENGAGED_GAP_CAP_MS = 5 * 60_000` (5 minutes). Hardcoded; no config surface.
- Both consumption sites use the identical fallback expression: `s.engagedMs ?? Math.max(0, s.endMs - s.startMs)`.
- The wire/DB field name stays `activeMs` (in `ObservePayload.pulse`, `home.controller`, `routes.ts`, aggregator schema). Do **not** rename it. Only its computation and the UI label change.
- Per-session `durationMs` (`observeAggregate.ts` sessions list) stays the wall-clock span — do not touch it.
- Insight tests run against source via Vitest (`import … from "../x.js"`); no dist build needed for `@agentgem/insight`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work happens on branch `engaged-time` (already checked out in worktree `../agentgem-worktrees/engaged-time`).

---

### Task 1: Pure `engagedMsFromTimestamps` helper + optional `SessionStat.engagedMs`

**Files:**
- Modify: `packages/insight/src/observeAggregate.ts` (add helper near top-of-file exports; add field to `SessionStat` interface ~line 14-31)
- Test: `packages/insight/src/__tests__/engagedMs.test.ts` (create)

**Interfaces:**
- Produces: `export const ENGAGED_GAP_CAP_MS: number` and `export function engagedMsFromTimestamps(timestamps: number[], capMs?: number): number`. Also `SessionStat` gains `engagedMs?: number`.

- [ ] **Step 1: Write the failing test**

Create `packages/insight/src/__tests__/engagedMs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { engagedMsFromTimestamps, ENGAGED_GAP_CAP_MS } from "../observeAggregate.js";

const MIN = 60_000;

describe("engagedMsFromTimestamps", () => {
  it("returns 0 for empty or single-element input", () => {
    expect(engagedMsFromTimestamps([])).toBe(0);
    expect(engagedMsFromTimestamps([1000])).toBe(0);
  });

  it("counts a small gap in full", () => {
    expect(engagedMsFromTimestamps([0, 30_000])).toBe(30_000); // 30s < cap
  });

  it("caps a gap larger than the threshold at the cap", () => {
    expect(engagedMsFromTimestamps([0, 3 * 60 * MIN])).toBe(ENGAGED_GAP_CAP_MS); // 3h idle -> 5min
  });

  it("sums a mix of small and capped gaps", () => {
    // gaps: 30s, 3h(->cap), 20s, 8min(->cap)
    const t = [0, 30_000, 30_000 + 3 * 60 * MIN, 30_000 + 3 * 60 * MIN + 20_000,
      30_000 + 3 * 60 * MIN + 20_000 + 8 * MIN];
    expect(engagedMsFromTimestamps(t)).toBe(30_000 + ENGAGED_GAP_CAP_MS + 20_000 + ENGAGED_GAP_CAP_MS);
  });

  it("is order-independent (sorts internally)", () => {
    expect(engagedMsFromTimestamps([30_000, 0, 60_000])).toBe(60_000); // gaps 30s + 30s
  });

  it("honors a custom cap", () => {
    expect(engagedMsFromTimestamps([0, 120_000], 60_000)).toBe(60_000); // 2min gap, 1min cap
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight exec vitest run src/__tests__/engagedMs.test.ts`
Expected: FAIL — `engagedMsFromTimestamps` / `ENGAGED_GAP_CAP_MS` not exported.

- [ ] **Step 3: Add the helper and the optional field**

In `packages/insight/src/observeAggregate.ts`, add these exports immediately above `export interface SessionStat {` (currently line 14):

```ts
/** Idle-gap cap for engaged-time: a single gap between two consecutive records
 *  contributes at most this. Strips human-away stretches while still counting
 *  genuine work up to the cap. */
export const ENGAGED_GAP_CAP_MS = 5 * 60_000; // 5 minutes

/** Engaged (compute) time for one session: the sum of gaps between consecutive
 *  record timestamps, each capped at `capMs`. Input need not be sorted. A long
 *  idle gap therefore adds only `capMs`, not its full span. */
export function engagedMsFromTimestamps(timestamps: number[], capMs = ENGAGED_GAP_CAP_MS): number {
  if (timestamps.length < 2) return 0;
  const t = timestamps.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < t.length; i++) sum += Math.min(t[i] - t[i - 1], capMs);
  return sum;
}
```

Then add the field inside the `SessionStat` interface, immediately after the `endMs: number;` line (currently line 22):

```ts
  // Engaged (compute) time in ms — sum of capped record-to-record gaps
  // (ENGAGED_GAP_CAP_MS). Optional: older/foreign stats omit it, and consumers
  // fall back to the wall-clock span (endMs - startMs) when absent.
  engagedMs?: number;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/insight exec vitest run src/__tests__/engagedMs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-worktrees/engaged-time
git add packages/insight/src/observeAggregate.ts packages/insight/src/__tests__/engagedMs.test.ts
git commit -m "feat(insight): add engagedMsFromTimestamps helper + optional SessionStat.engagedMs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Populate `engagedMs` in the scan parsers + consume it in `aggregateObserve`

**Files:**
- Modify: `packages/insight/src/observeScan.ts` (import; `parseClaudeTranscript`; `parseCodexTranscript`)
- Modify: `packages/insight/src/observeAggregate.ts` (`pActive` line, currently line 125)
- Test: `packages/insight/src/__tests__/engagedScan.test.ts` (create)

**Interfaces:**
- Consumes: `engagedMsFromTimestamps` from Task 1.
- Produces: `SessionStat.engagedMs` populated for `agent: "claude"` and `agent: "codex"` sessions; `aggregateObserve(...).pulse.activeMs` now equals `Σ (s.engagedMs ?? span)`.

- [ ] **Step 1: Write the failing test**

Create `packages/insight/src/__tests__/engagedScan.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight exec vitest run src/__tests__/engagedScan.test.ts`
Expected: FAIL — `s.engagedMs` is `undefined` (parser not populating), and `pulse.activeMs` uses the span-sum (equals `1000 + 5000`, not `350_000 + 5000`).

- [ ] **Step 3a: Import the helper into `observeScan.ts`**

In `packages/insight/src/observeScan.ts`, the existing type-only import (currently line 19) is:

```ts
import type { SessionStat } from "./observeAggregate.js";
```

Add a value import directly below it:

```ts
import { engagedMsFromTimestamps } from "./observeAggregate.js";
```

- [ ] **Step 3b: Collect timestamps + set `engagedMs` in `parseClaudeTranscript`**

In `parseClaudeTranscript`, the declaration line (currently line 81) is:

```ts
  let startMs = Infinity, endMs = -Infinity, msgs = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
```

Add a timestamp accumulator right after it:

```ts
  const tsList: number[] = [];
```

The gap-tracking line (currently line 88) is:

```ts
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
```

Replace it with (push the timestamp too):

```ts
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); tsList.push(ts); }
```

The return statement (currently line 114) is:

```ts
  return { agent: "claude", sessionId, project: projectLabel(cwd, normalize), cwd, model, gitBranch, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache, ...usageFields(tools, skills, subagents) };
```

Insert `engagedMs` after `endMs`:

```ts
  return { agent: "claude", sessionId, project: projectLabel(cwd, normalize), cwd, model, gitBranch, startMs, endMs, engagedMs: engagedMsFromTimestamps(tsList), msgs, tokensIn, tokensOut, tokensCache, ...usageFields(tools, skills, subagents) };
```

- [ ] **Step 3c: Same three edits in `parseCodexTranscript`**

The declaration line (currently line 119):

```ts
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
```

Add after it:

```ts
  const tsList: number[] = [];
```

The gap-tracking line (currently line 124):

```ts
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
```

Replace with:

```ts
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); tsList.push(ts); }
```

The return statement (currently line 145):

```ts
  return { agent: "codex", sessionId, project: projectLabel(cwd, normalize), cwd, model, gitBranch: null, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache: cached, ...usageFields(tools, {}, {}) };
```

Insert `engagedMs` after `endMs`:

```ts
  return { agent: "codex", sessionId, project: projectLabel(cwd, normalize), cwd, model, gitBranch: null, startMs, endMs, engagedMs: engagedMsFromTimestamps(tsList), msgs, tokensIn, tokensOut, tokensCache: cached, ...usageFields(tools, {}, {}) };
```

- [ ] **Step 3d: Consume `engagedMs` in `aggregateObserve`**

In `packages/insight/src/observeAggregate.ts`, the pulse accumulation line (currently line 125) is:

```ts
    pTokens += tokensOf(s); pMsgs += s.msgs; pActive += Math.max(0, s.endMs - s.startMs);
```

Replace with:

```ts
    pTokens += tokensOf(s); pMsgs += s.msgs; pActive += s.engagedMs ?? Math.max(0, s.endMs - s.startMs);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/insight exec vitest run src/__tests__/engagedScan.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full insight suite (guard against regressions)**

Run: `pnpm --filter @agentgem/insight test`
Expected: PASS — existing observe tests still green (they feed span-equal fixtures; the fallback covers stats without `engagedMs`).

- [ ] **Step 6: Commit**

```bash
cd ../agentgem-worktrees/engaged-time
git add packages/insight/src/observeScan.ts packages/insight/src/observeAggregate.ts packages/insight/src/__tests__/engagedScan.test.ts
git commit -m "feat(insight): compute engaged time from transcript timestamps; pulse uses it

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Cache-version bumps so field-less records aren't served stale

**Files:**
- Modify: `packages/insight/src/analysisCache.ts` (`TOKEN_VERSION`, currently line 21)
- Modify: `packages/insight/src/sources.ts` (`ParseCacheFile` type line 95, load-check line 102, write line 116)
- Test: `packages/insight/src/__tests__/parseCacheDisk.test.ts` (add a rejection case)

**Interfaces:**
- Consumes: nothing new.
- Produces: the whole-scan/token caches invalidate (via `TOKEN_VERSION` "v4"); the per-file parse cache rejects `v: 1` files and writes `v: 2`.

- [ ] **Step 1: Write the failing test**

First, add `statSync` to this file's existing `node:fs` import (currently line 10):

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
```

Then append this case inside the existing `describe("persisted parse cache", …)` block. It reuses the file's `transcript()` helper and `cachePath()`:

```ts
  it("rejects a v1 parse-cache file so pre-engagedMs stats are re-parsed", async () => {
    // Craft a v1 entry that WOULD be a cache hit (matching mtime/size) but whose
    // cached stat predates engagedMs and carries a sentinel msgs. If the loader
    // still accepted v1, the scan would serve the stale stat; it must not.
    transcript("a");
    const file = join(claude, "a.jsonl");
    const { mtimeMs, size } = statSync(file);
    const staleStat = {
      agent: "claude", sessionId: "a", project: "proj", cwd: "/tmp/proj", model: null,
      gitBranch: null, startMs: 1, endMs: 2, msgs: 999, tokensIn: 0, tokensOut: 0, tokensCache: 0,
    };
    mkdirSync(join(home, ".agentgem", "cache"), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ v: 1, entries: { [file]: { mtimeMs, size, stat: staleStat } } }));

    const mod = await import("../sources.js");
    await mod.loadParseCacheFromDisk();
    const stats = await mod.BUILTIN_SOURCES.find((s) => s.id === "claude")!.scanSessions!([claude]);

    // v1 rejected -> re-parsed from the real transcript: real msgs (not 999) and engagedMs present.
    expect(stats[0].msgs).not.toBe(999);
    expect(typeof stats[0].engagedMs).toBe("number");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/insight exec vitest run src/__tests__/parseCacheDisk.test.ts -t "rejects a v1"`
Expected: FAIL — the current `v: 1` loader accepts the file, so the scan serves the stale stat (`msgs === 999`, and `engagedMs` is `undefined`), failing both assertions. (Also, before Task 2 is merged the real parser wouldn't set `engagedMs`; this task follows Task 2, where it does.)

- [ ] **Step 3a: Bump `TOKEN_VERSION`**

In `packages/insight/src/analysisCache.ts`, the version line (currently line 21) is:

```ts
const TOKEN_VERSION = "v3";
```

Replace with (extend the running comment above it in the same style as v2/v3):

```ts
// v4 = SessionStat now carries `engagedMs`; v3 entries (which lack it, and whose
// pulse.activeMs was the old span-sum) must not be served.
const TOKEN_VERSION = "v4";
```

- [ ] **Step 3b: Bump the per-file parse cache to v2**

In `packages/insight/src/sources.ts`:

Type (currently line 95):

```ts
interface ParseCacheFile { v: 1; entries: Record<string, { mtimeMs: number; size: number; stat: SessionStat | null }> }
```
→
```ts
interface ParseCacheFile { v: 2; entries: Record<string, { mtimeMs: number; size: number; stat: SessionStat | null }> }
```

Load check (currently line 102):

```ts
    if (raw?.v !== 1 || !raw.entries) return;
```
→
```ts
    if (raw?.v !== 2 || !raw.entries) return;
```

Write (currently line 116):

```ts
    const file: ParseCacheFile = { v: 1, entries: Object.fromEntries(_parseCache) };
```
→
```ts
    const file: ParseCacheFile = { v: 2, entries: Object.fromEntries(_parseCache) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentgem/insight exec vitest run src/__tests__/parseCacheDisk.test.ts`
Expected: PASS — v1 file rejected, v2 round-trips.

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-worktrees/engaged-time
git add packages/insight/src/analysisCache.ts packages/insight/src/sources.ts packages/insight/src/__tests__/parseCacheDisk.test.ts
git commit -m "fix(insight): bump scan-cache versions so pre-engagedMs stats aren't served

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Home/Reveal ledger + UI labels

**Files:**
- Modify: `packages/app/src/home.controller.ts` (`activeMs` accumulation, currently line 84)
- Modify: `packages/console/src/panels/Observe/Dashboard.tsx` (Stat label, currently line 74)
- Modify: `packages/console/src/panels/Observe/Reveal.tsx` (ledger label, currently line 98)

**Interfaces:**
- Consumes: `SessionStat.engagedMs` from Task 2 (already populated for claude/codex).
- Produces: the Home ledger's `usage.activeMs` uses engaged time; the two UI figures read "engaged".

- [ ] **Step 1: Switch the Home controller to engaged time**

In `packages/app/src/home.controller.ts`, the accumulation line (currently line 84) is:

```ts
      activeMs += Math.max(0, s.endMs - s.startMs);
```

Replace with:

```ts
      activeMs += s.engagedMs ?? Math.max(0, s.endMs - s.startMs);
```

- [ ] **Step 2: Rename the Overview stat label**

In `packages/console/src/panels/Observe/Dashboard.tsx`, the stat (currently line 74) is:

```tsx
          <Stat label="active" value={fmtDuration(data.pulse.activeMs)} />
```

Replace with:

```tsx
          <Stat label="engaged" value={fmtDuration(data.pulse.activeMs)} />
```

- [ ] **Step 3: Rename the Reveal ledger label**

In `packages/console/src/panels/Observe/Reveal.tsx`, the ledger item (currently line 98) is:

```tsx
        <span className="reveal-ledger-item"><b>{hours}</b> active hours</span>
```

Replace with:

```tsx
        <span className="reveal-ledger-item"><b>{hours}</b> engaged hours</span>
```

- [ ] **Step 4: Verify no test asserted the old label text**

Run: `grep -rn '"active"\|active hours' packages/console/src/panels/Observe/*.test.tsx`
Expected: no matches referencing the *label* (only unrelated `aria-current` "active" filter-row assertions, which are about a selected row, not the stat label). If any test asserts the label text `active`/`active hours`, update it to `engaged`/`engaged hours`.

- [ ] **Step 5: Run the affected suites**

Run: `pnpm --filter @agentgem/app test`
Run: `pnpm --filter @agentgem/console test`
Expected: PASS. (Console fixtures feed `activeMs` directly, so rendering is unaffected; the label rename touches no assertion per Step 4.)

- [ ] **Step 6: Commit**

```bash
cd ../agentgem-worktrees/engaged-time
git add packages/app/src/home.controller.ts packages/console/src/panels/Observe/Dashboard.tsx packages/console/src/panels/Observe/Reveal.tsx
git commit -m "feat(console,app): Overview + Reveal show engaged time, labeled 'engaged'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Full typecheck + build from repo root (the console bundle must rebuild — `tsc -b` alone leaves it stale): `pnpm build`
- [ ] Run the three touched suites together: `pnpm --filter @agentgem/insight test && pnpm --filter @agentgem/app test && pnpm --filter @agentgem/console test`
- [ ] Optional real-browser check via the `verify` skill: launch the console, open Observe → Overview, confirm the stat is labeled "engaged" and its value is far below the old span-sum for a day with long-idle sessions.
- [ ] Confirm the branch is ahead of `origin/main` only, then open a PR (CI gate `test (24)`), per the repo's PR lifecycle.

## Self-Review notes (author)

- **Spec coverage:** helper (Task 1) ✓; parser population + pulse consumption (Task 2) ✓; cache invalidation, both tiers (Task 3) ✓; Home ledger + both labels (Task 4) ✓; TDD tests in every task ✓.
- **Deviation from spec:** `engagedMs` is *optional* with a centralized fallback rather than a *required* field with five foreign-parser edits. Same user-visible behavior (local claude/codex get real engaged time; foreign imports keep span), matches the interface's existing optional-field convention, smaller diff. Foreign-source population is a documented follow-up, not part of this plan.
- **Type consistency:** `engagedMsFromTimestamps` / `ENGAGED_GAP_CAP_MS` / `engagedMs` used identically across tasks.
