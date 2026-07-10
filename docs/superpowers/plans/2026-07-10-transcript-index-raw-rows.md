# Transcript Index: Raw Rows, Resolved at Query Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transcript index inventory-independent — store raw, file-derived tokens and resolve them against the current inventory at query time — so installing a skill or MCP server reparses nothing instead of re-reading 3.1 GB (17.4 s).

**Architecture:** `scanFileUsage(path, hooks)` extracts raw skill/MCP tokens (a pure function of the file's bytes) plus resolved hook hits (hooks have no token — they are matched by their own event/command from the inventory). `transcriptIndex` stores those in `raw_usage` + `hook_usage`, invalidating only on `hook_digest` or `schema_version`. `resolveUsage(raw, hooks, inv)` maps tokens to artifact names and aggregates at query time.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:sqlite` `DatabaseSync`, vitest (runs against compiled `dist/`).

**Spec:** `docs/superpowers/specs/2026-07-10-transcript-index-raw-rows-design.md`

## Global Constraints

- **Worktree:** `/Users/rfeng/Projects/ninemind/agentgem-raw-index`, branch `perf/transcript-index-raw-rows`, based on `origin/main`.
- **Tests run against compiled `dist/`.** Root `vitest.config.ts` includes only `dist/**/__tests__/**/*.test.js`. Run `pnpm exec tsc -b` before `pnpm exec vitest`, and target the **`dist/`** path.
- **CI does not run `packages/*/src/__tests__`.** `packages/capture` and `packages/insight` have no `test` script. Every test in this plan therefore lives under root `src/gem/__tests__/` — the existing precedent (`src/gem/__tests__/transcriptIndex.test.ts`, `src/gem/__tests__/globalUsage.test.ts`).
- **`packages/insight/src/workflowScan.ts` is classified as binary by `grep`** (a stray control byte). Use `grep -a` on it. `Read`/`Edit` work normally.
- **Dependency direction: `@agentgem/capture` imports `@agentgem/insight`, never the reverse.** `resolveUsage` returns a `GlobalUsageResult` (defined in capture), so it MUST live in capture. Putting it in insight creates a cycle.
- **`matchSkill` / `matchMcpServer` are order-dependent** (`find`, first match over inventory order). Mint-time and query-time MUST use the same exported functions over the same inventory order. Never re-implement them.
- **`ms = safeMtime(path)` is the FILE's mtime** (`workflowScan.ts:395`), so every row a file produces shares one `last_used_ms`. This is not a per-record timestamp.
- **`sessionsUsedIn` means distinct transcript files.** `touch()`'s 5th parameter is named `sessionId` but all five call sites pass `path`. Never store a session count; compute `paths.size` at query time.
- ESM import specifiers end in `.js`, even for `.ts` sources.
- **Map keys use a single space as separator, split with `indexOf(" ")` (first space wins).** Safe because `kind` (`skill` | `mcp_server`) and `type` (`skill` | `mcp_server` | `hook`) are closed sets with no spaces, so a token or artifact name containing a space still parses correctly. Do NOT "fix" this to a `` separator: a literal NUL byte makes the file binary-classified and `grep` then silently skips it — which is already true of `packages/insight/src/workflowScan.ts` and costs real debugging time.
- Commit after every task. Never commit directly to `main`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/insight/src/workflowScan.ts` *(modify)* | Export `matchSkill`, `matchMcpServer`, `mcpServerToken`, `firstHookCommand`. No behavior change. |
| `packages/insight/src/rawUsageScan.ts` *(create)* | `scanFileUsage(path, hooks)` — one file → raw tokens + hook hits. Pure w.r.t. skills/MCP. |
| `packages/insight/src/index.ts` *(modify)* | Re-export `rawUsageScan.js`. |
| `packages/capture/src/resolveUsage.ts` *(create)* | `resolveUsage(raw, hooks, inv)` — token → name, then aggregate. Pure, no I/O. |
| `packages/capture/src/transcriptIndex.ts` *(modify)* | Schema v2: `raw_usage` + `hook_usage`; `hook_digest`; `syncUsage()` replaces `syncGlobalUsage()`. |
| `packages/capture/src/globalUsage.ts` *(modify)* | `hookDigest()`; rewire `getGlobalUsageIndexed`; delete `inventoryDigest`. |
| `packages/capture/src/index.ts` *(modify)* | Re-export `resolveUsage.js`. |
| `src/gem/__tests__/rawUsageScan.test.ts` *(create)* | Token extraction + hook detection + assistant-only guard. |
| `src/gem/__tests__/resolveUsage.test.ts` *(create)* | Aggregation, `sessionsUsedIn`, two-tokens-one-artifact, unresolved dropped. |
| `src/gem/__tests__/transcriptIndex.test.ts` *(rewrite)* | v2 API; **delete** the `inv_digest` rebuild test; add hook-digest + no-reparse tests. |
| `src/gem/__tests__/globalUsage.test.ts` *(modify)* | Keep; add the differential test. |

---

### Task 1: Export the matchers, and extract raw tokens from one file

**Files:**
- Modify: `packages/insight/src/workflowScan.ts:390` (`matchSkill` closure → exported fn), `:149` (`mcpServerToken`), `:157` (`matchMcpServer`), `:166` (`firstHookCommand`)
- Create: `packages/insight/src/rawUsageScan.ts`
- Modify: `packages/insight/src/index.ts`
- Test: `src/gem/__tests__/rawUsageScan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `matchSkill(list: { name: string }[], skill: string): { name: string } | undefined`
  - `matchMcpServer(token: string, servers: { name: string }[]): string | null`
  - `mcpServerToken(toolName: string): string`
  - `firstHookCommand(config: Record<string, unknown>): string | null`
  - `interface RawUsageRow { kind: "skill" | "mcp_server"; token: string; invocations: number }`
  - `interface HookUsageRow { name: string; invocations: number }`
  - `interface FileUsage { raw: RawUsageRow[]; hooks: HookUsageRow[]; lastUsedMs: number }`
  - `scanFileUsage(path: string, hooks: HookArtifact[]): FileUsage`

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/rawUsageScan.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFileUsage, matchSkill, matchMcpServer, mcpServerToken } from "@agentgem/insight";
import type { HookArtifact } from "@agentgem/model";

let dir: string;
const line = (o: unknown) => JSON.stringify(o);
const toolUse = (name: string, input?: unknown) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "raw-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, lines: string[]) => {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
};

describe("scanFileUsage", () => {
  it("extracts raw skill tokens verbatim, counting invocations", () => {
    const p = write("a.jsonl", [
      toolUse("Skill", { skill: "superpowers:brainstorming" }),
      toolUse("Skill", { skill: "superpowers:brainstorming" }),
      toolUse("Skill", { skill: "qa" }),
    ]);
    const u = scanFileUsage(p, []);
    expect(u.raw.filter((r) => r.kind === "skill").sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { kind: "skill", token: "qa", invocations: 1 },
      { kind: "skill", token: "superpowers:brainstorming", invocations: 2 },
    ]);
  });

  it("reduces an mcp tool name to its server token", () => {
    const p = write("b.jsonl", [toolUse("mcp__plugin_context7_context7__query-docs", {})]);
    expect(scanFileUsage(p, []).raw).toEqual([
      { kind: "mcp_server", token: "plugin_context7_context7", invocations: 1 },
    ]);
  });

  // The system-prompt tool catalog also lists mcp__ names but is NOT an assistant
  // message. That is the availability-vs-usage guard; it must survive here.
  it("ignores tool_use blocks that are not on an assistant message", () => {
    const p = write("c.jsonl", [
      line({ type: "user", message: { role: "user", content: [{ type: "tool_use", name: "Skill", input: { skill: "qa" } }] } }),
    ]);
    expect(scanFileUsage(p, []).raw).toEqual([]);
  });

  it("ignores a Skill call with no input.skill, and unknown builtins", () => {
    const p = write("d.jsonl", [toolUse("Skill", {}), toolUse("Bash", { command: "ls" })]);
    expect(scanFileUsage(p, []).raw).toEqual([]);
  });

  it("skips malformed lines and blank lines without throwing", () => {
    const p = write("e.jsonl", ["", "{not json", toolUse("Skill", { skill: "qa" }), ""]);
    expect(scanFileUsage(p, []).raw).toEqual([{ kind: "skill", token: "qa", invocations: 1 }]);
  });

  it("returns an empty result for a missing file", () => {
    expect(scanFileUsage(join(dir, "nope.jsonl"), [])).toEqual({ raw: [], hooks: [], lastUsedMs: 0 });
  });

  // Hooks have no token: a hook fired iff a hook-signal record contains that hook's
  // own event name or its command basename, both taken from the inventory.
  it("resolves hook hits against the hook inventory, by event or command basename", () => {
    const hooks: HookArtifact[] = [
      { type: "hook", name: "stopper", event: "Stop", config: { hooks: [{ command: "/usr/local/bin/notify.sh" }] } },
      { type: "hook", name: "pre", event: "PreToolUse", config: { hooks: [{ command: "/x/guard.sh" }] } },
      { type: "hook", name: "never", event: "Nope", config: { hooks: [{ command: "/x/absent.sh" }] } },
    ];
    const p = write("f.jsonl", [
      line({ type: "system", content: "PreToolUse hook success" }),
      line({ type: "system", content: "Hook fired: notify.sh done" }),
    ]);
    const u = scanFileUsage(p, hooks);
    expect(u.hooks.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "pre", invocations: 1 },
      { name: "stopper", invocations: 1 },
    ]);
  });

  it("uses the file mtime as lastUsedMs (not a per-record timestamp)", () => {
    const p = write("g.jsonl", [toolUse("Skill", { skill: "qa" })]);
    const u = scanFileUsage(p, []);
    expect(u.lastUsedMs).toBeGreaterThan(0);
  });
});

describe("exported matchers (must be shared by mint and query, never re-implemented)", () => {
  it("matchSkill accepts an exact name or a namespaced suffix", () => {
    const list = [{ name: "brainstorming" }];
    expect(matchSkill(list, "brainstorming")?.name).toBe("brainstorming");
    expect(matchSkill(list, "superpowers:brainstorming")?.name).toBe("brainstorming");
    expect(matchSkill(list, "brainstorm")).toBeUndefined();
  });

  it("matchSkill is first-match-wins over inventory order", () => {
    const list = [{ name: "a" }, { name: "b" }];
    expect(matchSkill(list, "x:a")?.name).toBe("a");
  });

  it("matchMcpServer matches equal or substring, case-insensitively", () => {
    const servers = [{ name: "context7" }];
    expect(matchMcpServer("context7", servers)).toBe("context7");
    expect(matchMcpServer("plugin_context7_context7", servers)).toBe("context7");
    expect(matchMcpServer("other", servers)).toBeNull();
  });

  it("mcpServerToken strips the mcp__ prefix and the trailing __tool", () => {
    expect(mcpServerToken("mcp__plugin_context7_context7__query-docs")).toBe("plugin_context7_context7");
    expect(mcpServerToken("mcp__bare")).toBe("bare");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-raw-index
pnpm install --frozen-lockfile
pnpm exec tsc -b
```

Expected: FAILS with `error TS2305: Module '"@agentgem/insight"' has no exported member 'scanFileUsage'` (and `matchSkill`, `matchMcpServer`).

- [ ] **Step 3: Write minimal implementation**

**3a.** In `packages/insight/src/workflowScan.ts`, export the three module-level helpers. Change **only** the `function` keyword lines — do not touch their bodies:

- line 149: `function mcpServerToken(` → `export function mcpServerToken(`
- line 157: `function matchMcpServer(` → `export function matchMcpServer(`
- line 166: `function firstHookCommand(` → `export function firstHookCommand(`

**3b.** In `packages/insight/src/workflowScan.ts`, `matchSkill` is currently a closure *inside* `scanWorkflow` at line 390:

```ts
  const matchSkill = (list: { name: string }[], skill: string) => list.find((s) => s.name === skill || skill.endsWith(`:${s.name}`));
```

Delete that line, and add this module-level export next to `matchMcpServer` (after line 165). `scanWorkflow`'s two call sites (`:448`, `:449`) then resolve to the module-level function unchanged:

```ts
// Match an inventory skill to a runtime Skill(...) token. The token may be namespaced
// ("superpowers:brainstorming"), so an exact hit or a `:`-suffix hit both count.
// EXPORTED because the transcript index resolves stored raw tokens at QUERY time and
// must use this exact function, in this exact inventory order — `find` is first-match-wins,
// so a re-implementation would silently resolve differently.
export function matchSkill(list: { name: string }[], skill: string): { name: string } | undefined {
  return list.find((s) => s.name === skill || skill.endsWith(`:${s.name}`));
}
```

**3c.** Create `packages/insight/src/rawUsageScan.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rawUsageScan.ts
//
// One transcript file -> its usage contribution, split by what determines it.
//
//  - skills and mcp servers are TOKEN-DRIVEN: the transcript carries the token
//    (`Skill(superpowers:brainstorming)`, `mcp__ctx7__query-docs`). The inventory only decides
//    what that token RESOLVES to. So the token is stored raw, and resolution happens at query
//    time — which is why installing a skill no longer invalidates a single parsed file.
//
//  - hooks are INVENTORY-DRIVEN: a hook has no token. You can only tell one fired by searching
//    each record for THAT hook's own event name and command basename, both read from the
//    inventory's `config`. So hook hits are resolved here, at parse time, and a hook change
//    still forces a reparse. That asymmetry is the whole reason `hook_digest` survives.
//
// Mirrors scanWorkflow's detection exactly (assistant-only tool_use, the Skill/mcp__ dispatch,
// the hook-signal heuristic). scanWorkflow remains the source of truth for everything else;
// a differential test pins this function's output to it.
import { readFileSync } from "node:fs";
import type { HookArtifact } from "@agentgem/model";
import { safeMtime, mcpServerToken, firstHookCommand } from "./workflowScan.js";

export interface RawUsageRow { kind: "skill" | "mcp_server"; token: string; invocations: number }
export interface HookUsageRow { name: string; invocations: number }
export interface FileUsage { raw: RawUsageRow[]; hooks: HookUsageRow[]; lastUsedMs: number }

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function scanFileUsage(path: string, hooks: HookArtifact[]): FileUsage {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { raw: [], hooks: [], lastUsedMs: 0 }; }
  // Per-FILE mtime, exactly as scanWorkflow does — not a per-record timestamp.
  const lastUsedMs = safeMtime(path);

  const rawCount = new Map<string, number>();   // `${kind} ${token}`
  const hookCount = new Map<string, number>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; } // a corrupt line contributes nothing
    const r = rec as { message?: { role?: string; content?: unknown }; role?: string };

    // Only ASSISTANT messages carry real tool_use invocations. The system-prompt tool
    // catalog also lists mcp__ names but is not an assistant message — availability, not usage.
    const role = r?.message?.role ?? r?.role;
    const content = r?.message?.content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const block of content as { type?: string; name?: string; input?: { skill?: unknown } }[]) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const name = block.name;
        if (name === "Skill" && typeof block.input?.skill === "string") bump(rawCount, `skill ${block.input.skill}`);
        else if (name.startsWith("mcp__")) bump(rawCount, `mcp_server ${mcpServerToken(name)}`);
      }
    }

    // Hook firing is low-confidence: hooks aren't tool_use, they surface as injected
    // "... hook success:" / hook-event text. Match by event or command basename.
    const flat = typeof rec === "string" ? rec : JSON.stringify(rec);
    if (flat.includes("hook success") || /Hook\b/.test(flat)) {
      for (const h of hooks) {
        const cmd = firstHookCommand(h.config);
        const base = cmd ? cmd.split("/").pop()! : "";
        if ((h.event && flat.includes(h.event)) || (base && flat.includes(base))) bump(hookCount, h.name);
      }
    }
  }

  const raw: RawUsageRow[] = [...rawCount.entries()].map(([key, invocations]) => {
    const sep = key.indexOf(" ");
    return { kind: key.slice(0, sep) as RawUsageRow["kind"], token: key.slice(sep + 1), invocations };
  });
  return { raw, hooks: [...hookCount.entries()].map(([name, invocations]) => ({ name, invocations })), lastUsedMs };
}
```

**3d.** In `packages/insight/src/index.ts`, add after the `export * from "./workflowScan.js";` line:

```ts
export * from "./rawUsageScan.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/rawUsageScan.test.js
```

Expected: `Tests 11 passed (11)`.

Then confirm nothing regressed in the scan itself (the `matchSkill` move):

```bash
pnpm exec vitest run dist/gem/__tests__/globalUsage.test.js dist/__tests__/optimizeScope.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/workflowScan.ts packages/insight/src/rawUsageScan.ts packages/insight/src/index.ts src/gem/__tests__/rawUsageScan.test.ts
git commit -m "feat(insight): scanFileUsage — raw tokens per file, hooks resolved at parse

Skills and mcp servers are token-driven: the transcript carries the token and the
inventory only maps it. Hooks are inventory-driven: a hook has no token, it is
matched by its own event/command. Export matchSkill/matchMcpServer so mint-time and
query-time resolution cannot drift (find() is first-match-wins over inventory order)."
```

---

### Task 2: `resolveUsage` — map tokens to names and aggregate

**Files:**
- Create: `packages/capture/src/resolveUsage.ts`
- Modify: `packages/capture/src/index.ts`
- Test: `src/gem/__tests__/resolveUsage.test.ts`

**Interfaces:**
- Consumes: `matchSkill`, `matchMcpServer` from `@agentgem/insight` (Task 1).
- Produces:
  - `interface StoredRawRow { path: string; kind: "skill" | "mcp_server"; token: string; invocations: number; lastUsedMs: number | null }`
  - `interface StoredHookRow { path: string; name: string; invocations: number; lastUsedMs: number | null }`
  - `resolveUsage(raw: StoredRawRow[], hooks: StoredHookRow[], global: { skills: { name: string }[]; mcpServers: { name: string }[] }): GlobalUsageResult`

**Why this lives in `capture`, not `insight`:** it returns `GlobalUsageResult`, which is defined in `packages/capture/src/globalUsage.ts`. Capture imports insight; the reverse would be a cycle.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/resolveUsage.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { resolveUsage, type StoredRawRow, type StoredHookRow } from "@agentgem/capture";

const inv = { skills: [{ name: "brainstorming" }, { name: "qa" }], mcpServers: [{ name: "context7" }] };
const raw = (path: string, kind: "skill" | "mcp_server", token: string, invocations: number, lastUsedMs: number | null): StoredRawRow =>
  ({ path, kind, token, invocations, lastUsedMs });

describe("resolveUsage", () => {
  it("resolves tokens to inventory names and sums invocations", () => {
    const res = resolveUsage([raw("/a", "skill", "qa", 3, 100), raw("/b", "skill", "qa", 5, 250)], [], inv);
    expect(res.artifacts).toEqual([
      { type: "skill", name: "qa", root: null, invocations: 8, sessionsUsedIn: 2, lastUsedMs: 250 },
    ]);
  });

  // THE point of the design: two distinct raw tokens map to one artifact. Had we stored a
  // per-row session count, SUM would report 2 sessions for a single file. Counting distinct
  // paths makes that impossible by construction.
  it("counts sessionsUsedIn as DISTINCT PATHS, so two tokens in one file are one session", () => {
    const res = resolveUsage(
      [raw("/a", "skill", "brainstorming", 1, 10), raw("/a", "skill", "superpowers:brainstorming", 2, 10)],
      [], inv,
    );
    expect(res.artifacts).toEqual([
      { type: "skill", name: "brainstorming", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 10 },
    ]);
  });

  it("takes MAX lastUsedMs across paths and tolerates nulls", () => {
    const res = resolveUsage([raw("/a", "skill", "qa", 1, null), raw("/b", "skill", "qa", 1, 42)], [], inv);
    expect(res.artifacts[0].lastUsedMs).toBe(42);
  });

  it("returns null lastUsedMs when no row has one", () => {
    expect(resolveUsage([raw("/a", "skill", "qa", 1, null)], [], inv).artifacts[0].lastUsedMs).toBeNull();
  });

  // Unresolved tokens stay in the table (the caller keeps them) but never reach the output.
  // Install the skill later and they light up with no reparse — what the wipe was reaching for.
  it("drops tokens that resolve to nothing, without throwing", () => {
    expect(resolveUsage([raw("/a", "skill", "not-installed", 9, 1)], [], inv).artifacts).toEqual([]);
  });

  it("resolves an mcp token by substring, per matchMcpServer", () => {
    const res = resolveUsage([raw("/a", "mcp_server", "plugin_context7_context7", 4, 7)], [], inv);
    expect(res.artifacts).toEqual([
      { type: "mcp_server", name: "context7", root: null, invocations: 4, sessionsUsedIn: 1, lastUsedMs: 7 },
    ]);
  });

  it("passes hook rows straight through, aggregated the same way", () => {
    const hooks: StoredHookRow[] = [
      { path: "/a", name: "stopper", invocations: 2, lastUsedMs: 5 },
      { path: "/b", name: "stopper", invocations: 1, lastUsedMs: 9 },
    ];
    expect(resolveUsage([], hooks, inv).artifacts).toEqual([
      { type: "hook", name: "stopper", root: null, invocations: 3, sessionsUsedIn: 2, lastUsedMs: 9 },
    ]);
  });

  it("orders by invocations DESC then name ASC", () => {
    const res = resolveUsage(
      [raw("/a", "skill", "qa", 1, 1), raw("/a", "skill", "brainstorming", 5, 1), raw("/a", "mcp_server", "context7", 5, 1)],
      [], inv,
    );
    expect(res.artifacts.map((a) => a.name)).toEqual(["brainstorming", "context7", "qa"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsc -b
```

Expected: FAILS with `error TS2305: Module '"@agentgem/capture"' has no exported member 'resolveUsage'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/capture/src/resolveUsage.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/resolveUsage.ts
//
// The query-time half of the transcript index. `raw_usage` stores tokens exactly as the
// transcript carried them; this maps them onto the CURRENT inventory and folds them into the
// global result. Because nothing here is persisted, installing a skill changes the answer with
// no file re-read.
//
// Lives in capture (not insight) because it returns GlobalUsageResult, which capture defines.
// Capture imports insight; the reverse would be a cycle.
import { matchSkill, matchMcpServer } from "@agentgem/insight";
import type { GlobalUsageResult } from "./globalUsage.js";

export interface StoredRawRow { path: string; kind: "skill" | "mcp_server"; token: string; invocations: number; lastUsedMs: number | null }
export interface StoredHookRow { path: string; name: string; invocations: number; lastUsedMs: number | null }

interface Acc { type: string; name: string; invocations: number; paths: Set<string>; lastUsedMs: number | null }

function fold(acc: Map<string, Acc>, type: string, name: string, path: string, invocations: number, lastUsedMs: number | null): void {
  const key = `${type} ${name}`;
  const e = acc.get(key) ?? { type, name, invocations: 0, paths: new Set<string>(), lastUsedMs: null };
  e.invocations += invocations;
  e.paths.add(path);
  if (lastUsedMs != null) e.lastUsedMs = e.lastUsedMs == null ? lastUsedMs : Math.max(e.lastUsedMs, lastUsedMs);
  acc.set(key, e);
}

export function resolveUsage(
  raw: StoredRawRow[],
  hooks: StoredHookRow[],
  global: { skills: { name: string }[]; mcpServers: { name: string }[] },
): GlobalUsageResult {
  const acc = new Map<string, Acc>();
  for (const r of raw) {
    // Same exported matchers, same inventory order, as the resolved-at-parse path used.
    const name = r.kind === "skill" ? matchSkill(global.skills, r.token)?.name : matchMcpServer(r.token, global.mcpServers);
    if (!name) continue; // unresolved: retained in the table, omitted from the result
    fold(acc, r.kind, name, r.path, r.invocations, r.lastUsedMs);
  }
  for (const h of hooks) fold(acc, "hook", h.name, h.path, h.invocations, h.lastUsedMs);

  return {
    artifacts: [...acc.values()]
      .map((e) => ({
        type: e.type,
        name: e.name,
        root: null as null,
        invocations: e.invocations,
        // `sessionsUsedIn` has always meant DISTINCT TRANSCRIPT FILES: touch()'s `sessionId`
        // parameter receives `path` at every call site. Counting paths is exactly equivalent,
        // and makes two-tokens-one-artifact impossible to double-count.
        sessionsUsedIn: e.paths.size,
        lastUsedMs: e.lastUsedMs,
      }))
      .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name)),
  };
}
```

In `packages/capture/src/index.ts`, add:

```ts
export * from "./resolveUsage.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/resolveUsage.test.js
```

Expected: `Tests 8 passed (8)`.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/resolveUsage.ts packages/capture/src/index.ts src/gem/__tests__/resolveUsage.test.ts
git commit -m "feat(capture): resolveUsage — map raw tokens to the current inventory at query time

sessionsUsedIn counts DISTINCT PATHS, not a stored session count: touch()'s
'sessionId' parameter receives `path` at every call site, so this is exactly
equivalent and makes two-tokens-one-artifact impossible to double-count."
```

---

### Task 3: Index schema v2 — `raw_usage` + `hook_usage`, `hook_digest`

**Files:**
- Modify: `packages/capture/src/transcriptIndex.ts` (whole file)
- Test: `src/gem/__tests__/transcriptIndex.test.ts` (rewrite)

**Interfaces:**
- Consumes: `StoredRawRow`, `StoredHookRow` (Task 2); `FileUsage` (Task 1).
- Produces:
  - `SCHEMA_VERSION = "2"`
  - `syncUsage(paths: string[], hookDigest: string, parseFile: (path: string) => FileUsage): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }>`
  - `syncGlobalUsage` and `UsageRow` are **deleted**.

**Delete the existing `"rebuilds when the inventory digest changes"` test** (`transcriptIndex.test.ts:96-111`). It asserts exactly the behavior this task removes. Replace it with the hook-digest and no-reparse tests below. Do not keep it "just in case."

- [ ] **Step 1: Write the failing test**

Replace the whole body of `src/gem/__tests__/transcriptIndex.test.ts`:

```ts
// src/gem/__tests__/transcriptIndex.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTranscriptIndex, type TranscriptIndex } from "@agentgem/capture";
import type { FileUsage } from "@agentgem/insight";

// A stand-in parser: returns whatever FileUsage the test registered for a path, and counts
// how many times each path was actually (re)parsed, so we can assert what does NOT reparse.
function makeParser() {
  const files = new Map<string, FileUsage>();
  const parseCount = new Map<string, number>();
  const parseFile = (path: string): FileUsage => {
    parseCount.set(path, (parseCount.get(path) ?? 0) + 1);
    return files.get(path) ?? { raw: [], hooks: [], lastUsedMs: 0 };
  };
  return { files, parseCount, parseFile };
}

function write(path: string, content: string, mtimeSec?: number) {
  writeFileSync(path, content);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

describe("transcript index — raw rows, inventory-independent", () => {
  let dir: string;
  let index: TranscriptIndex;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidx-"));
    index = await openTranscriptIndex("memory://");
  });
  afterEach(async () => {
    await index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores raw rows keyed by path and returns them with hook rows", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a");
    const { files, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "x:qa", invocations: 3 }], hooks: [{ name: "stopper", invocations: 1 }], lastUsedMs: 100 });

    const out = await index.syncUsage([a], "hooks1", parseFile);
    expect(out.raw).toEqual([{ path: a, kind: "skill", token: "x:qa", invocations: 3, lastUsedMs: 100 }]);
    expect(out.hooks).toEqual([{ path: a, name: "stopper", invocations: 1, lastUsedMs: 100 }]);
  });

  it("reparses only changed files; unchanged files are skipped", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a", 1_000);
    write(b, "b", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [], lastUsedMs: 10 });
    files.set(b, { raw: [{ kind: "mcp_server", token: "ctx", invocations: 2 }], hooks: [], lastUsedMs: 20 });

    await index.syncUsage([a, b], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(1);
    expect(parseCount.get(b)).toBe(1);

    files.set(b, { raw: [{ kind: "mcp_server", token: "ctx", invocations: 9 }], hooks: [], lastUsedMs: 99 });
    write(b, "b-changed-longer", 2_000);

    const out = await index.syncUsage([a, b], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(1); // a NOT reparsed
    expect(parseCount.get(b)).toBe(2);
    expect(out.raw.find((r) => r.path === b)?.invocations).toBe(9);
  });

  // The whole point: the inventory is no longer an input to the stored rows, so a skill
  // install cannot invalidate them. There is no digest to pass.
  it("does NOT reparse when only the skill/mcp inventory changes", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [], lastUsedMs: 10 });

    await index.syncUsage([a], "hooks1", parseFile);
    await index.syncUsage([a], "hooks1", parseFile); // same hook digest, unchanged file
    expect(parseCount.get(a)).toBe(1);
  });

  // Hooks are inventory-driven, so a hook change DOES force a reparse — but raw rows survive.
  it("a changed hook digest reparses every file and clears hook rows, keeping raw rows", async () => {
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "old", invocations: 1 }], lastUsedMs: 10 });

    await index.syncUsage([a], "hooks1", parseFile);
    expect(parseCount.get(a)).toBe(1);

    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "new", invocations: 2 }], lastUsedMs: 10 });
    const out = await index.syncUsage([a], "hooks2", parseFile);
    expect(parseCount.get(a)).toBe(2);                       // file reparsed despite same mtime/size
    expect(out.hooks).toEqual([{ path: a, name: "new", invocations: 2, lastUsedMs: 10 }]);
    expect(out.raw).toEqual([{ path: a, kind: "skill", token: "qa", invocations: 1, lastUsedMs: 10 }]);
  });

  it("prunes files that disappear from the path set", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { files, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [], lastUsedMs: 10 });
    files.set(b, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [{ name: "h", invocations: 1 }], lastUsedMs: 20 });

    await index.syncUsage([a, b], "hooks1", parseFile);
    rmSync(b);
    const out = await index.syncUsage([a], "hooks1", parseFile);
    expect(out.raw).toEqual([{ path: a, kind: "skill", token: "qa", invocations: 1, lastUsedMs: 10 }]);
    expect(out.hooks).toEqual([]);
  });

  it("a corrupt file contributes nothing and does not abort the sync", async () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, "a");
    write(b, "b");
    const { files, parseFile } = makeParser();
    files.set(b, { raw: [{ kind: "skill", token: "qa", invocations: 1 }], hooks: [], lastUsedMs: 20 });
    const throwing = (p: string) => { if (p === a) throw new Error("corrupt"); return parseFile(p); };

    const out = await index.syncUsage([a, b], "hooks1", throwing);
    expect(out.raw).toEqual([{ path: b, kind: "skill", token: "qa", invocations: 1, lastUsedMs: 20 }]);
  });

  it("persists across reopen and reparses nothing when unchanged", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "tidx-store-"));
    const store = join(storeDir, "transcript-index.db");
    const a = join(dir, "a.jsonl");
    write(a, "a", 1_000);
    const { files, parseCount, parseFile } = makeParser();
    files.set(a, { raw: [{ kind: "skill", token: "qa", invocations: 4 }], hooks: [], lastUsedMs: 10 });

    const first = await openTranscriptIndex(store);
    await first.syncUsage([a], "hooks1", parseFile);
    await first.close();
    expect(parseCount.get(a)).toBe(1);

    const second = await openTranscriptIndex(store);
    const out = await second.syncUsage([a], "hooks1", parseFile);
    await second.close();
    expect(parseCount.get(a)).toBe(1);
    expect(out.raw[0].invocations).toBe(4);
    rmSync(storeDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsc -b
```

Expected: FAILS — `Property 'syncUsage' does not exist on type 'TranscriptIndex'`.

- [ ] **Step 3: Write minimal implementation**

Rewrite `packages/capture/src/transcriptIndex.ts`. Keep the existing header comment's first paragraph, replace the rest:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/transcriptIndex.ts
//
// A persistent, incremental index of session transcripts, backed by the on-disk node:sqlite we
// already ship (see docs/superpowers/specs/2026-07-01-transcript-index-design.md, and
// docs/superpowers/specs/2026-07-10-transcript-index-raw-rows-design.md).
//
// Phase 2 stores each transcript's RAW contribution — the tokens the file itself carried — so the
// stored rows are a pure function of the file's bytes. Resolution against the inventory happens at
// query time (see resolveUsage). Installing a skill or an MCP server therefore reparses NOTHING;
// previously it wiped the table and re-read the whole corpus (17.4s on a 3.1GB home).
//
// Hooks are the exception and the reason `hook_digest` survives: a hook has no token, it is matched
// by searching each record for that hook's own event/command from the inventory. So hook hits are
// resolved at parse time, and a hook change forces a reparse. Raw rows survive that reparse.
//
// The core is I/O-injected: `parseFile` comes from the caller, so the store is testable without
// touching real config/introspection.
import { DatabaseSync } from "node:sqlite";
import { statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { FileUsage } from "@agentgem/insight";
import type { StoredRawRow, StoredHookRow } from "./resolveUsage.js";

// "2": raw_usage/hook_usage replace global_usage; inv_digest is gone. A bump drops derived rows.
const SCHEMA_VERSION = "2";

export interface TranscriptIndex {
  /**
   * Reconcile the index against `paths` and return the stored rows.
   * Reparses only new/changed files (by mtime+size); prunes vanished files. A changed
   * `hookDigest` forces a reparse (hook hits are resolved at parse time) but keeps raw rows.
   * The skill/mcp inventory is NOT an input — resolution happens in resolveUsage.
   */
  syncUsage(
    paths: string[],
    hookDigest: string,
    parseFile: (path: string) => FileUsage,
  ): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }>;
  close(): Promise<void>;
}

/** ~/.agentgem/transcript-index.db — the on-disk node:sqlite file for the local transcript index. */
export function defaultIndexDir(): string {
  return join(agentgemHome(), ".agentgem", "transcript-index.db");
}

export async function openTranscriptIndex(dataDir?: string): Promise<TranscriptIndex> {
  const dir = dataDir ?? defaultIndexDir();
  const file = dir === "memory://" ? ":memory:" : dir;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS transcript_file (
      path      TEXT PRIMARY KEY,
      mtime_ms  REAL NOT NULL,
      size      REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raw_usage (
      path         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      token        TEXT NOT NULL,
      invocations  INTEGER NOT NULL,
      last_used_ms REAL,
      PRIMARY KEY (path, kind, token)
    );
    CREATE TABLE IF NOT EXISTS hook_usage (
      path         TEXT NOT NULL,
      name         TEXT NOT NULL,
      invocations  INTEGER NOT NULL,
      last_used_ms REAL,
      PRIMARY KEY (path, name)
    );
  `);
  // Schema-version guard: a bump means the on-disk layout may be incompatible, so drop the derived
  // rows (they rebuild on next sync) and the v1 table + its orphaned digest. meta itself is stable.
  const ver = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  if (ver !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS global_usage;");
    db.exec("DELETE FROM raw_usage; DELETE FROM hook_usage; DELETE FROM transcript_file;");
    db.exec("DELETE FROM meta WHERE key = 'inv_digest';");
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    ).run(SCHEMA_VERSION);
  }

  // Single-flight: the SWR caller can fire overlapping syncs; serialize them so two passes never
  // interleave writes to the same rows.
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;

  return {
    syncUsage(paths, hookDigest, parseFile) {
      const run = chain.then(() => doSync(db, paths, hookDigest, parseFile));
      chain = run.catch(() => {}); // keep the chain alive past a failed sync
      return run;
    },
    async close() {
      if (!closed) { db.close(); closed = true; }
    },
  };
}

async function doSync(
  db: DatabaseSync,
  paths: string[],
  hookDigest: string,
  parseFile: (path: string) => FileUsage,
): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }> {
  // 1. Hook-digest guard. Hook hits are RESOLVED at parse time (a hook has no token), so a changed
  //    hook inventory means every file must be re-searched. Clearing transcript_file is what forces
  //    that. raw_usage is untouched: it depends only on file bytes, and the reparse re-upserts it.
  const stored = (db.prepare("SELECT value FROM meta WHERE key = 'hook_digest'").get() as { value: string } | undefined)?.value;
  if (stored !== hookDigest) {
    db.exec("DELETE FROM hook_usage; DELETE FROM transcript_file;");
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('hook_digest', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    ).run(hookDigest);
  }

  // 2. Load current file identities. AFTER the guard, so a cleared transcript_file reparses all.
  const existing = new Map<string, { mtime: number; size: number }>();
  for (const r of db.prepare("SELECT path, mtime_ms, size FROM transcript_file").all() as { path: string; mtime_ms: number; size: number }[]) {
    existing.set(r.path, { mtime: Number(r.mtime_ms), size: Number(r.size) });
  }

  const seen = new Set<string>();
  db.exec("BEGIN");
  try {
    // 3. Reparse only new/changed files.
    for (const path of paths) {
      let st: ReturnType<typeof statSync>;
      try { st = statSync(path); } catch { continue; } // vanished between listing and stat
      seen.add(path);
      const prev = existing.get(path);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue; // unchanged

      let u: FileUsage;
      try { u = parseFile(path); } catch { u = { raw: [], hooks: [], lastUsedMs: 0 }; } // corrupt → nothing
      db.prepare("DELETE FROM raw_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM hook_usage WHERE path = ?1").run(path);
      for (const r of u.raw) {
        db.prepare(
          `INSERT INTO raw_usage(path, kind, token, invocations, last_used_ms) VALUES(?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(path, kind, token) DO UPDATE SET invocations = ?4, last_used_ms = ?5`,
        ).run(path, r.kind, r.token, r.invocations, u.lastUsedMs);
      }
      for (const h of u.hooks) {
        db.prepare(
          `INSERT INTO hook_usage(path, name, invocations, last_used_ms) VALUES(?1, ?2, ?3, ?4)
           ON CONFLICT(path, name) DO UPDATE SET invocations = ?3, last_used_ms = ?4`,
        ).run(path, h.name, h.invocations, u.lastUsedMs);
      }
      db.prepare(
        `INSERT INTO transcript_file(path, mtime_ms, size) VALUES(?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = ?2, size = ?3`,
      ).run(path, st.mtimeMs, st.size);
    }
    // 4. Prune files that are gone from disk.
    for (const path of existing.keys()) {
      if (seen.has(path)) continue;
      db.prepare("DELETE FROM raw_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM hook_usage WHERE path = ?1").run(path);
      db.prepare("DELETE FROM transcript_file WHERE path = ?1").run(path);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
    throw e;
  }

  // 5. Hand the stored rows to the caller; resolution + folding happens in resolveUsage.
  const raw = (db.prepare("SELECT path, kind, token, invocations, last_used_ms FROM raw_usage ORDER BY path, kind, token").all() as
    { path: string; kind: string; token: string; invocations: number; last_used_ms: number | null }[])
    .map((r) => ({ path: r.path, kind: r.kind as StoredRawRow["kind"], token: r.token, invocations: Number(r.invocations), lastUsedMs: r.last_used_ms == null ? null : Number(r.last_used_ms) }));
  const hooks = (db.prepare("SELECT path, name, invocations, last_used_ms FROM hook_usage ORDER BY path, name").all() as
    { path: string; name: string; invocations: number; last_used_ms: number | null }[])
    .map((r) => ({ path: r.path, name: r.name, invocations: Number(r.invocations), lastUsedMs: r.last_used_ms == null ? null : Number(r.last_used_ms) }));
  return { raw, hooks };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/transcriptIndex.test.js
```

Expected: `Tests 7 passed (7)`. `tsc -b` will also error in `globalUsage.ts` (it still calls `syncGlobalUsage`) — that is Task 4. If `tsc -b` blocks the test run, do Task 4's Step 3a first, then return here; note it in your report.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/transcriptIndex.ts src/gem/__tests__/transcriptIndex.test.ts
git commit -m "feat(capture): transcript index schema v2 — raw_usage + hook_usage

Stored rows are now a pure function of the file's bytes, so a skill/mcp install
reparses nothing. Only hook_digest (hooks are matched by their own event/command,
so they have no token) and schema_version force a reparse. Deletes the
inv_digest rebuild path and its test."
```

---

### Task 4: Rewire `getGlobalUsageIndexed` onto the raw path

**Files:**
- Modify: `packages/capture/src/globalUsage.ts:32-41` (delete `inventoryDigest`), `:82-93` (`getGlobalUsageIndexed`)
- Test: `src/gem/__tests__/globalUsage.test.ts`

**Interfaces:**
- Consumes: `syncUsage` (Task 3), `resolveUsage` (Task 2), `scanFileUsage` (Task 1).
- Produces: `hookDigest(hooks: HookArtifact[]): string`. `getGlobalUsageIndexed` keeps its exact signature and return type — callers are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/globalUsage.test.ts`:

```ts
describe("getGlobalUsageIndexed — inventory-independent", () => {
  it("returns the same artifacts as computeGlobalUsage for the same corpus", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);
    const want = computeGlobalUsage(dirs, paths).artifacts;
    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    await closeSharedIndex();
    const key = (a: { type: string; name: string }) => `${a.type} ${a.name}`;
    const sort = <T extends { type: string; name: string }>(xs: T[]) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
    expect(sort(got)).toEqual(sort(want));
  });

  it("hookDigest changes when a hook's config changes, not when a skill is added", () => {
    const h = (cmd: string) => [{ type: "hook" as const, name: "s", event: "Stop", config: { hooks: [{ command: cmd }] } }];
    expect(hookDigest(h("/a.sh"))).toBe(hookDigest(h("/a.sh")));
    expect(hookDigest(h("/a.sh"))).not.toBe(hookDigest(h("/b.sh")));
  });
});
```

Add `getGlobalUsageIndexed` and `hookDigest` to the file's existing `@agentgem/capture` import.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsc -b
```

Expected: FAILS — `Module '"@agentgem/capture"' has no exported member 'hookDigest'`, and `transcriptIndex.ts` no longer exports `syncGlobalUsage`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `packages/capture/src/globalUsage.ts`, delete `inventoryDigest` (lines 32-41 — nothing else calls it; confirm with `grep -rn "inventoryDigest" packages src`). Update the imports: remove `type UsageRow`, add what is needed:

```ts
import { createHash } from "node:crypto";
import { introspectConfig } from "./introspect.js";
import { scanWorkflow, scanFileUsage } from "@agentgem/insight";
import type { HookArtifact, resolveDirs } from "@agentgem/model";
import { openTranscriptIndex, defaultIndexDir, type TranscriptIndex } from "./transcriptIndex.js";
import { resolveUsage } from "./resolveUsage.js";
```

(`resolveDirs` is already imported as a type; keep whatever form the file already uses. `HookArtifact` may need adding.)

**3b.** Add `hookDigest` where `inventoryDigest` used to be:

```ts
// A stable fingerprint of the HOOK inventory only. Hook hits are resolved at PARSE time (a hook
// has no token — it is matched by its own event/command), so a hook change invalidates stored hook
// rows and forces a reparse. Skills and mcp servers are resolved at QUERY time and therefore do NOT
// belong in this digest: installing one must reparse nothing.
export function hookDigest(hooks: HookArtifact[]): string {
  const norm = hooks
    .map((h) => ({ n: h.name, e: h.event ?? "", c: h.config ?? null }))
    .sort((a, b) => a.n.localeCompare(b.n));
  return createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}
```

**3c.** Replace `getGlobalUsageIndexed` (lines 82-93):

```ts
/**
 * Global usage via the persistent incremental index: same result as `computeGlobalUsage`, but only
 * new/changed transcripts are reparsed — and, unlike before, an inventory change reparses NOTHING
 * (raw tokens are stored; resolution happens here, per call). The caller should fall back to
 * `computeGlobalUsage` if this rejects.
 */
export async function getGlobalUsageIndexed(dirs: ReturnType<typeof resolveDirs>, paths: string[]): Promise<GlobalUsageResult> {
  const globalInv = introspectConfig(dirs);
  const hooks = globalInv.hooks;
  const parseFile = (path: string) => scanFileUsage(path, hooks);
  const index = await sharedIndex();
  const stored = await index.syncUsage(paths, hookDigest(hooks), parseFile);
  return resolveUsage(stored.raw, stored.hooks, { skills: globalInv.skills, mcpServers: globalInv.mcpServers });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/globalUsage.test.js dist/gem/__tests__/transcriptIndex.test.js
```

Expected: all pass.

Then the full root suite, because this changes a shared module:

```bash
pnpm exec vitest run 2>&1 | tail -6
```

Expected: 0 failures. `src/warm/__tests__/registry.test.ts` exercises the `usage` warmable through this path — if it fails, that is a real regression, not a test to update.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/globalUsage.ts src/gem/__tests__/globalUsage.test.ts
git commit -m "feat(capture): getGlobalUsageIndexed resolves raw tokens per call

inv_digest is gone. hookDigest covers hooks only, because only hooks are resolved
at parse time. Installing a skill or mcp server now reparses nothing."
```

---

### Task 5: The differential test — the merge gate

**Files:**
- Create: `src/gem/__tests__/usageDifferential.test.ts`

**Interfaces:**
- Consumes: `computeGlobalUsage`, `getGlobalUsageIndexed`, `closeSharedIndex` (`@agentgem/capture`).

`matchSkill` and `matchMcpServer` are lossy and order-dependent. Unit tests do not prove the query-time path reproduces the parse-time path over a real corpus. This does. It is the gate.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/usageDifferential.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The gate for the raw-rows change. `computeGlobalUsage` resolves at PARSE time; the indexed path
// stores raw tokens and resolves at QUERY time. matchSkill/matchMcpServer are lossy and
// order-dependent (`find`, first match wins), so equivalence is a property to PROVE over a corpus,
// not to assume from unit tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGlobalUsage, getGlobalUsageIndexed, closeSharedIndex } from "@agentgem/capture";
import { allClaudeTranscripts } from "@agentgem/insight";
import { resolveDirs } from "@agentgem/model";

let home: string, claudeDir: string, prevHome: string | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "diff-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;        // keep the index db inside the fixture
  claudeDir = join(home, ".claude");

  // A skill whose runtime token is namespaced (exercises matchSkill's `:`-suffix branch),
  // one addressed by its bare name, and one that is never installed (must stay unresolved).
  for (const n of ["brainstorming", "qa"]) {
    const d = join(claudeDir, "skills", n);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\nbody`);
  }
  // An MCP server whose runtime token embeds its name (exercises matchMcpServer's substring branch).
  writeFileSync(join(claudeDir, ".mcp.json"), JSON.stringify({ mcpServers: { context7: { command: "x" } } }));
  // A hook, so hook rows participate too.
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify.sh" }] }] },
  }));

  const tu = (name: string, input?: unknown) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
  const a = join(claudeDir, "projects", "encA"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "a.jsonl"), [
    JSON.stringify({ cwd: "/projA" }),
    tu("Skill", { skill: "superpowers:brainstorming" }),   // namespaced token
    tu("Skill", { skill: "brainstorming" }),               // bare token -> SAME artifact, same file
    tu("Skill", { skill: "never-installed" }),             // unresolved
    tu("mcp__plugin_context7_context7__query-docs", {}),   // substring token
    JSON.stringify({ type: "system", content: "Stop hook success: notify.sh" }),
  ].join("\n") + "\n");
  const b = join(claudeDir, "projects", "encB"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "b.jsonl"), [
    JSON.stringify({ cwd: "/projB" }),
    tu("Skill", { skill: "qa" }),
    tu("mcp__plugin_context7_context7__other", {}),
  ].join("\n") + "\n");
});

afterAll(async () => {
  await closeSharedIndex();
  if (prevHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const key = (a: { type: string; name: string }) => `${a.type} ${a.name}`;
const sorted = <T extends { type: string; name: string }>(xs: T[]) => [...xs].sort((x, y) => key(x).localeCompare(key(y)));

describe("differential: query-time resolution == parse-time resolution", () => {
  it("produces identical artifacts (type, name, invocations, sessionsUsedIn, lastUsedMs)", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);
    const want = computeGlobalUsage(dirs, paths).artifacts;
    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    expect(sorted(got)).toEqual(sorted(want));
    expect(want.length).toBeGreaterThan(0); // guard: an empty corpus would make this vacuous
  });

  // Two tokens ("superpowers:brainstorming", "brainstorming") resolve to ONE artifact in ONE file.
  // If sessionsUsedIn were a stored per-row count, this would report 2.
  it("counts one session when two raw tokens resolve to one artifact in one file", async () => {
    const dirs = resolveDirs(claudeDir);
    const got = (await getGlobalUsageIndexed(dirs, allClaudeTranscripts(dirs.claudeDir))).artifacts;
    const b = got.find((a) => a.name === "brainstorming")!;
    expect(b.invocations).toBe(2);
    expect(b.sessionsUsedIn).toBe(1);
  });

  it("omits an unresolved token from the result", async () => {
    const dirs = resolveDirs(claudeDir);
    const got = (await getGlobalUsageIndexed(dirs, allClaudeTranscripts(dirs.claudeDir))).artifacts;
    expect(got.find((a) => a.name === "never-installed")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Before Tasks 1-4 exist this would not compile. Run it now, after them:

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/usageDifferential.test.js
```

Expected: PASS. **If it fails, the raw path does not reproduce the old resolution — stop and fix the implementation, never the expectation.** The most likely cause is inventory iteration order feeding `matchSkill`/`matchMcpServer`, or a detection guard in `scanFileUsage` that diverges from `scanWorkflow`'s.

- [ ] **Step 3: Add the no-reparse test**

Append to `src/gem/__tests__/usageDifferential.test.ts`:

```ts
describe("installing a skill reparses nothing", () => {
  it("resolves a previously-unresolved token without re-reading any file", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);

    // Warm the index. "never-installed" is stored as a raw token, unresolved.
    await getGlobalUsageIndexed(dirs, paths);

    // Install the skill. No transcript changes: mtime and size are untouched.
    const d = join(claudeDir, "skills", "never-installed");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "---\nname: never-installed\ndescription: d\n---\nbody");

    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    const n = got.find((a) => a.name === "never-installed");
    expect(n).toBeTruthy();          // it lights up...
    expect(n!.invocations).toBe(1);  // ...with its historical usage, from stored raw rows
  });
});
```

- [ ] **Step 4: Run both**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/usageDifferential.test.js
```

Expected: `Tests 4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add src/gem/__tests__/usageDifferential.test.ts
git commit -m "test: differential gate — query-time resolution equals parse-time resolution

matchSkill/matchMcpServer are lossy and order-dependent, so equivalence is proven
over a corpus, not assumed. Also pins the two properties the design turns on:
two tokens -> one artifact is one session, and installing a skill resolves
historical usage with no reparse."
```

---

### Task 6: Measure on the real corpus, then record it

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-transcript-index-raw-rows-design.md`

Tests prove equivalence. They do not prove the 17.4 s went away. Measure it.

- [ ] **Step 1: Full build + both suites**

```bash
pnpm clean && pnpm build && pnpm exec vitest run 2>&1 | tail -6
```

Expected: 0 failures.

- [ ] **Step 2: Back up the real index, then measure a cold build and a skill install**

The script writes to `~/.agentgem/transcript-index.db`. Back it up first; restore at the end.

```bash
cp ~/.agentgem/transcript-index.db /tmp/tidx-backup.db
cat > /tmp/measure-raw.mjs <<'EOF'
const R = '/Users/rfeng/Projects/ninemind/agentgem-raw-index';
const ws = await import(`${R}/packages/insight/dist/workflowScan.js`);
const rd = await import(`${R}/packages/model/dist/resolveDir.js`);
const gu = await import(`${R}/packages/capture/dist/globalUsage.js`);
const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const dirs = rd.resolveDirs(undefined);
const paths = ws.allClaudeTranscripts(dirs.claudeDir);
console.log(`${paths.length} transcripts`);

let s = performance.now();
await gu.getGlobalUsageIndexed(dirs, paths);
console.log(`  cold build (schema v2 migration): ${((performance.now()-s)/1000).toFixed(1)}s`);

s = performance.now();
await gu.getGlobalUsageIndexed(dirs, paths);
console.log(`  warm, unchanged:                  ${((performance.now()-s)/1000).toFixed(2)}s`);

// Install a skill: the exact event that used to force a 17.4s full reparse.
const d = `${process.env.HOME}/.claude/skills/__raw_index_probe__`;
mkdirSync(d, { recursive: true });
writeFileSync(`${d}/SKILL.md`, "---\nname: __raw_index_probe__\ndescription: probe\n---\nbody");
s = performance.now();
await gu.getGlobalUsageIndexed(dirs, paths);
console.log(`  after installing a skill:         ${((performance.now()-s)/1000).toFixed(2)}s   <-- was 17.4s`);
rmSync(d, { recursive: true, force: true });
await gu.closeSharedIndex();
EOF
node /tmp/measure-raw.mjs 2>&1 | grep -v Experimental | grep -v trace-warnings
```

Expected: cold ≈ 17 s (one-time migration); warm ≈ 0.10 s; **after installing a skill < 0.15 s** (was 17.4 s).

- [ ] **Step 3: Restore the real index and verify it is intact**

```bash
cp /tmp/tidx-backup.db ~/.agentgem/transcript-index.db
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.HOME + "/.agentgem/transcript-index.db");
for (const r of db.prepare("SELECT key, value FROM meta").all()) console.log(`  meta ${r.key} = ${String(r.value).slice(0,16)}`);
db.close();' 2>&1 | grep -v Experimental
```

Confirm the file is readable. (A `schema_version = 1` db here is fine: the next open migrates it.)

- [ ] **Step 4: Record the measured numbers**

In the spec's *Verification* table, replace `expected after` with the measured values from Step 2. If "after installing a skill" is not well under a second, **stop and investigate** — do not round a bad number into a good one. Add a line stating the observed cold-migration cost.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-10-transcript-index-raw-rows-design.md
git commit -m "docs: record the measured raw-index numbers"
```

---

## Self-Review

**Spec coverage.** Problem / the observation → Tasks 1, 2. Schema (`raw_usage`, `hook_usage`, `sessions_used_in` deleted) → Task 3. Invalidation table (`hook_digest` only) → Tasks 3, 4. Query-time resolution → Task 2. Data flow → Task 4. Error handling (corrupt file, unresolved token, schema guard, endpoint fallback untouched) → Tasks 1, 2, 3. Migration (`SCHEMA_VERSION` 1→2) → Task 3, verified in Task 6. Testing (differential gate, no-reparse, hook-digest, `sessionsUsedIn` equivalence, migration) → Tasks 3, 5, 6. Verification by measurement → Task 6. Non-goals (hooks stay resolved; first build stays on the event loop, tracked in #284) → no task, by design.

**Gap found and closed:** the spec did not say where `resolveUsage` lives. Capture imports insight, and `GlobalUsageResult` is defined in capture, so insight would be a cycle. Fixed in Task 2's *Interfaces* and the Global Constraints.

**Second gap:** the spec did not mention that `matchSkill` is a **closure inside `scanWorkflow`** (`:390`), not a module-level function. Task 1 Step 3b hoists and exports it — otherwise mint and query cannot share it, which is precisely what the differential test would catch.

**Third gap:** Task 3's `tsc -b` cannot pass until Task 4 removes `globalUsage.ts`'s call to the deleted `syncGlobalUsage`. Called out inline in Task 3 Step 4 so the implementer is not surprised.

**Type consistency.** `FileUsage` / `RawUsageRow` / `HookUsageRow` — defined in Task 1, consumed in Tasks 3, 4. `StoredRawRow` / `StoredHookRow` — defined in Task 2, consumed in Tasks 3, 4. `syncUsage(paths, hookDigest, parseFile)` — defined in Task 3, called in Task 4. `hookDigest(hooks)` — defined in Task 4, tested in Task 4. `matchSkill` returns `{ name } | undefined`; `matchMcpServer` returns `string | null` — both used accordingly in Task 2's `resolveUsage`.

**No placeholders.** Every code step carries real code; every run step carries a real command and its expected output.
