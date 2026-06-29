# Optimize Tab — Plan 1 (Panel + Local Analysis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Optimize" tab under the Observe group that shows (a) installed-but-unused skills/MCP servers to deactivate and (b) a CLAUDE.md/instructions weight & bloat health check — all from local data, no LLM, no tools.

**Architecture:** A new local read endpoint `GET /api/optimize` joins `introspectConfig()` (what's installed) with usage counts derived by reusing `scanWorkflow()` over all Claude transcripts (what actually fired). Pure domain logic (`optimizeAnalyze.ts`) builds the payload; a thin IO module (`optimizeScan.ts`) does the transcript scan + TTL cache; a new React panel renders three sections. This is Plan 1 of 3 from the spec — Discover (ACP) and semantic CLAUDE.md critique are later plans.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), AgentBack decorators (`@agentback/openapi`, `@agentback/client`), Zod, React, recharts/theme.css, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-optimize-tab-design.md`

## Global Constraints

- ESM imports MUST use `.js` extensions (e.g. `from "./workflowScan.js"`).
- Backend tests run via `tsc -b && vitest run` (package.json `test`) — compiled from `dist/`. Clean `dist/` after file renames/moves.
- Console builds via `node build-client.mjs`; typecheck via `tsc -p tsconfig.json --noEmit` (run from `packages/console/`).
- Recommend-only: NO config mutation anywhere in this plan.
- Context token estimate is `Math.ceil(text.length / 4)` everywhere — labeled as an estimate in the UI.
- Git identity for every commit: `Raymond Feng <raymond@ninemind.ai>`. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All work happens in the worktree `../agentgem-optimize` on branch `feat/optimize-tab`.
- **Simplification from spec (intentional):** v1 ships a **range selector only** (today/7d/30d/all). The spec's `facets`/agent/project filters are deferred — prune is a global view, so per-project filtering adds machinery without v1 value. `OptimizePayload` therefore omits `facets`.

## File Structure

- Create `src/gem/optimizeScan.ts` — IO: scan transcripts → per-artifact `ArtifactUsage` map (+ TTL cache). Reuses `scanWorkflow`.
- Create `src/gem/optimizeAnalyze.ts` — pure: `buildOptimizePayload(inv, usageMap, range, nowMs)` → `OptimizePayload` (prune flags, context-token estimates, change hints, plugin dedup, instructions health). No IO.
- Create `src/gem/__tests__/optimizeScan.test.ts` and `src/gem/__tests__/optimizeAnalyze.test.ts`.
- Modify `packages/console/src/api/routes.ts` — add `optimizeRoute` + Zod schemas + exported types.
- Modify `src/gem.controller.ts` — add `@get("/optimize")` handler.
- Create `packages/console/src/panels/Optimize/index.tsx` — `optimizePage` + `Optimize` component.
- Create `packages/console/src/panels/Optimize/Dashboard.tsx` — three-section renderer.
- Modify `packages/console/src/pages.tsx` — register `optimizePage`.
- Modify `packages/console/src/shell/theme.css` — `opt-*` styles.

---

### Task 1: `optimizeAnalyze.ts` — pure payload builder

Pure domain logic with zero IO, so it is fully unit-testable. Defines the payload types, the token estimator, prune rule, change-hint mapping, plugin dedup, and instructions health.

**Files:**
- Create: `src/gem/optimizeAnalyze.ts`
- Test: `src/gem/__tests__/optimizeAnalyze.test.ts`

**Interfaces:**
- Consumes: `ConfigInventory`, `SkillArtifact`, `McpServerArtifact`, `InstructionsArtifact`, `ProjectInventory` from `./types.js`; `ArtifactUsage` from `./workflowScan.js`.
- Produces:
  - `type OptimizeRange = "today" | "7d" | "30d" | "all"`
  - `interface OptimizeArtifact { name: string; type: "skill" | "mcp"; source: string; contextTokens: number; uses: number; lastUsedMs: number | null; prune: boolean; change: { file: string; key: string } }`
  - `interface OptimizeInstruction { name: string; source: string; contextTokens: number; lines: number; flags: ("oversized" | "very-long" | "duplicate-lines")[] }`
  - `interface OptimizePayload { range: OptimizeRange; artifacts: OptimizeArtifact[]; instructions: OptimizeInstruction[] }`
  - `function estTokens(text: string): number`
  - `function rangeStartMs(range: OptimizeRange, nowMs: number): number`
  - `function buildOptimizePayload(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number): OptimizePayload`
  - Usage map key convention: `` `${type}:${name}` `` where `type` is the `ArtifactType` (`"skill"` or `"mcp_server"`).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/optimizeAnalyze.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { estTokens, rangeStartMs, buildOptimizePayload } from "../optimizeAnalyze.js";
import type { ConfigInventory } from "../types.js";
import type { ArtifactUsage } from "../workflowScan.js";

const NOW = Date.parse("2026-06-29T00:00:00.000Z");
const DAY = 86_400_000;

function inv(over: Partial<ConfigInventory> = {}): ConfigInventory {
  return { skills: [], mcpServers: [], instructions: [], hooks: [], ...over };
}
function usage(rows: Array<[string, Partial<ArtifactUsage>]>): Map<string, ArtifactUsage> {
  const m = new Map<string, ArtifactUsage>();
  for (const [key, u] of rows) {
    m.set(key, { type: "skill", name: "", root: null, invocations: 0, sessionsUsedIn: 0, lastUsedMs: null, confidence: "high", ...u });
  }
  return m;
}

describe("estTokens", () => {
  it("is ceil(chars/4)", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
  });
});

describe("rangeStartMs", () => {
  it("maps ranges to a start cutoff; all = 0", () => {
    expect(rangeStartMs("all", NOW)).toBe(0);
    expect(rangeStartMs("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(rangeStartMs("30d", NOW)).toBe(NOW - 30 * DAY);
    expect(rangeStartMs("today", NOW)).toBe(NOW - DAY);
  });
});

describe("buildOptimizePayload — prune", () => {
  it("flags a never-used standalone skill as prunable with a skillOverrides change hint", () => {
    const c = inv({ skills: [{ type: "skill", name: "pdf-tools", description: "work with pdfs", source: "standalone", content: "x" }] });
    const p = buildOptimizePayload(c, usage([]), "30d", NOW);
    expect(p.artifacts).toHaveLength(1);
    const a = p.artifacts[0];
    expect(a).toMatchObject({ name: "pdf-tools", type: "skill", source: "standalone", uses: 0, lastUsedMs: null, prune: true });
    expect(a.contextTokens).toBe(estTokens("pdf-tools\nwork with pdfs"));
    expect(a.change).toEqual({ file: "settings.json", key: 'skillOverrides["pdf-tools"] = "off"' });
  });

  it("does NOT prune a skill used within the range, and reports its usage", () => {
    const c = inv({ skills: [{ type: "skill", name: "qa", description: "d", source: "standalone", content: "x" }] });
    const u = usage([["skill:qa", { type: "skill", name: "qa", invocations: 4, sessionsUsedIn: 2, lastUsedMs: NOW - 2 * DAY }]]);
    const a = buildOptimizePayload(c, u, "30d", NOW).artifacts[0];
    expect(a).toMatchObject({ uses: 4, prune: false });
    expect(a.lastUsedMs).toBe(NOW - 2 * DAY);
  });

  it("prunes a skill last used BEFORE the range window", () => {
    const c = inv({ skills: [{ type: "skill", name: "old", description: "d", source: "standalone", content: "x" }] });
    const u = usage([["skill:old", { name: "old", invocations: 1, sessionsUsedIn: 1, lastUsedMs: NOW - 40 * DAY }]]);
    const a = buildOptimizePayload(c, u, "30d", NOW).artifacts[0];
    expect(a.prune).toBe(true);
    expect(a.uses).toBe(1);
  });

  it("maps a plugin skill to an enabledPlugins hint and a user MCP to a mcpServers hint", () => {
    const c = inv({
      skills: [{ type: "skill", name: "review", description: "d", source: "plugin:brooks-lint", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "coingecko", transport: "stdio", config: { command: "x" }, source: "user" }],
    });
    const p = buildOptimizePayload(c, usage([]), "all", NOW);
    const skill = p.artifacts.find((a) => a.type === "skill")!;
    const mcp = p.artifacts.find((a) => a.type === "mcp")!;
    expect(skill.change).toEqual({ file: "settings.json", key: 'enabledPlugins["brooks-lint"] = false' });
    expect(mcp.change).toEqual({ file: "settings.json", key: "mcpServers.coingecko (remove, or add to deniedMcpServers)" });
  });

  it("sorts artifacts by contextTokens desc", () => {
    const c = inv({
      skills: [
        { type: "skill", name: "small", description: "x", source: "standalone", content: "x" },
        { type: "skill", name: "big", description: "x".repeat(400), source: "standalone", content: "x" },
      ],
    });
    const names = buildOptimizePayload(c, usage([]), "all", NOW).artifacts.map((a) => a.name);
    expect(names).toEqual(["big", "small"]);
  });

  it("collapses multiple unused artifacts from one plugin into a single row", () => {
    const c = inv({
      skills: [
        { type: "skill", name: "a", description: "d", source: "plugin:vercel", content: "x" },
        { type: "skill", name: "b", description: "d", source: "plugin:vercel", content: "x" },
      ],
    });
    const rows = buildOptimizePayload(c, usage([]), "all", NOW).artifacts.filter((a) => a.source === "plugin:vercel");
    expect(rows).toHaveLength(1);
  });
});

describe("buildOptimizePayload — instructions health", () => {
  it("estimates tokens, counts lines, and flags oversized + duplicate-lines", () => {
    const big = "rule\n".repeat(50) + "x".repeat(9000);
    const c = inv({ instructions: [{ type: "instructions", name: "CLAUDE.md", content: big }] });
    const ins = buildOptimizePayload(c, usage([]), "all", NOW).instructions[0];
    expect(ins.name).toBe("CLAUDE.md");
    expect(ins.contextTokens).toBe(estTokens(big));
    expect(ins.flags).toContain("oversized");
    expect(ins.flags).toContain("duplicate-lines");
  });

  it("flags very-long without oversized for many short lines", () => {
    const content = Array.from({ length: 320 }, (_, i) => `line ${i}`).join("\n");
    const c = inv({ instructions: [{ type: "instructions", name: "AGENTS.md", content }] });
    const ins = buildOptimizePayload(c, usage([]), "all", NOW).instructions[0];
    expect(ins.flags).toContain("very-long");
    expect(ins.lines).toBe(320);
  });

  it("includes per-project instructions and sorts by contextTokens desc", () => {
    const c = inv({
      instructions: [{ type: "instructions", name: "CLAUDE.md", content: "short" }],
      projects: [{ root: "/p", name: "p", skills: [], mcpServers: [], hooks: [],
        instructions: [{ type: "instructions", name: "p/CLAUDE.md", content: "x".repeat(8000) }] }],
    });
    const names = buildOptimizePayload(c, usage([]), "all", NOW).instructions.map((i) => i.name);
    expect(names[0]).toBe("p/CLAUDE.md");
    expect(names).toContain("CLAUDE.md");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize && npx vitest run src/gem/__tests__/optimizeAnalyze.test.ts`
Expected: FAIL — `Cannot find module '../optimizeAnalyze.js'` (or "does not provide an export").

- [ ] **Step 3: Write the implementation**

Create `src/gem/optimizeAnalyze.ts`:

```typescript
// src/gem/optimizeAnalyze.ts
//
// Pure (no IO) payload builder for GET /api/optimize. Joins the installed inventory
// with per-artifact usage to flag installed-but-unused skills/MCP, and derives a
// deterministic weight/health view of instructions (CLAUDE.md / AGENTS.md).
import type { ConfigInventory, McpServerArtifact, SkillArtifact, InstructionsArtifact } from "./types.js";
import type { ArtifactUsage } from "./workflowScan.js";

export type OptimizeRange = "today" | "7d" | "30d" | "all";

export interface OptimizeArtifact {
  name: string;
  type: "skill" | "mcp";
  source: string;
  contextTokens: number;          // estimate (chars/4)
  uses: number;                   // all-time invocations
  lastUsedMs: number | null;
  prune: boolean;                 // not used within the range
  change: { file: string; key: string };  // reversible deactivation hint
}

export interface OptimizeInstruction {
  name: string;
  source: string;
  contextTokens: number;          // estimate, loaded every session
  lines: number;
  flags: ("oversized" | "very-long" | "duplicate-lines")[];
}

export interface OptimizePayload {
  range: OptimizeRange;
  artifacts: OptimizeArtifact[];
  instructions: OptimizeInstruction[];
}

const DAY = 86_400_000;
const OVERSIZED_TOKENS = 2000;
const VERY_LONG_LINES = 300;
const DUP_LINE_MIN = 5;

export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function rangeStartMs(range: OptimizeRange, nowMs: number): number {
  switch (range) {
    case "all": return 0;
    case "today": return nowMs - DAY;
    case "7d": return nowMs - 7 * DAY;
    case "30d": return nowMs - 30 * DAY;
  }
}

// "plugin:brooks-lint" -> "brooks-lint"; anything else -> null.
function pluginKey(source: string): string | null {
  return source.startsWith("plugin:") ? source.slice("plugin:".length) : null;
}

function skillContextTokens(s: SkillArtifact): number {
  return estTokens(`${s.name}\n${s.description ?? ""}`);
}

// MCP tool schemas are injected at runtime and not knowable statically; estimate from
// the launch config as a floor (UI labels it "+ tool schemas at runtime").
function mcpContextTokens(m: McpServerArtifact): number {
  return estTokens(JSON.stringify(m.config));
}

function changeHint(type: "skill" | "mcp", name: string, source: string): { file: string; key: string } {
  const plugin = pluginKey(source);
  if (plugin) return { file: "settings.json", key: `enabledPlugins["${plugin}"] = false` };
  if (type === "skill") {
    if (source === "codex") return { file: "filesystem", key: `~/.codex/skills/${name} (move/remove)` };
    return { file: "settings.json", key: `skillOverrides["${name}"] = "off"` };
  }
  // mcp
  if (source === "codex") return { file: "~/.codex/config.toml", key: `set enabled = false for ${name}` };
  return { file: "settings.json", key: `mcpServers.${name} (remove, or add to deniedMcpServers)` };
}

function buildArtifacts(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number): OptimizeArtifact[] {
  const cutoff = rangeStartMs(range, nowMs);
  const out: OptimizeArtifact[] = [];

  const push = (type: "skill" | "mcp", name: string, source: string, contextTokens: number, key: string) => {
    const u = usage.get(key);
    const uses = u?.invocations ?? 0;
    const lastUsedMs = u?.lastUsedMs ?? null;
    const prune = lastUsedMs === null || lastUsedMs < cutoff;
    out.push({ name, type, source, contextTokens, uses, lastUsedMs, prune, change: changeHint(type, name, source) });
  };

  for (const s of inv.skills) push("skill", s.name, s.source, skillContextTokens(s), `skill:${s.name}`);
  for (const m of inv.mcpServers) push("mcp", m.name, m.source ?? "user", mcpContextTokens(m), `mcp_server:${m.name}`);

  // Collapse all unused artifacts of one plugin into the single biggest-saving row, so
  // we don't tell the user to disable the same plugin five times.
  const byPlugin = new Map<string, OptimizeArtifact[]>();
  const kept: OptimizeArtifact[] = [];
  for (const a of out) {
    const plugin = pluginKey(a.source);
    if (plugin && a.prune) {
      const arr = byPlugin.get(plugin) ?? [];
      arr.push(a);
      byPlugin.set(plugin, arr);
    } else {
      kept.push(a);
    }
  }
  for (const arr of byPlugin.values()) {
    arr.sort((x, y) => y.contextTokens - x.contextTokens);
    kept.push(arr[0]);
  }
  return kept.sort((a, b) => b.contextTokens - a.contextTokens);
}

function instructionHealth(name: string, source: string, content: string): OptimizeInstruction {
  const lines = content.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const contextTokens = estTokens(content);
  const counts = new Map<string, number>();
  for (const l of nonEmpty) {
    const t = l.trim();
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const dupTotal = [...counts.values()].filter((n) => n > 1).reduce((acc, n) => acc + n, 0);
  const flags: OptimizeInstruction["flags"] = [];
  if (contextTokens > OVERSIZED_TOKENS) flags.push("oversized");
  if (nonEmpty.length > VERY_LONG_LINES) flags.push("very-long");
  if (dupTotal >= DUP_LINE_MIN) flags.push("duplicate-lines");
  return { name, source, contextTokens, lines: nonEmpty.length, flags };
}

function buildInstructions(inv: ConfigInventory): OptimizeInstruction[] {
  const out: OptimizeInstruction[] = [];
  for (const i of inv.instructions) out.push(instructionHealth(i.name, "user", i.content));
  for (const p of inv.projects ?? []) {
    for (const i of p.instructions) out.push(instructionHealth(i.name, p.root, i.content));
  }
  return out.sort((a, b) => b.contextTokens - a.contextTokens);
}

export function buildOptimizePayload(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number): OptimizePayload {
  return {
    range,
    artifacts: buildArtifacts(inv, usage, range, nowMs),
    instructions: buildInstructions(inv),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize && npx vitest run src/gem/__tests__/optimizeAnalyze.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-optimize
git add src/gem/optimizeAnalyze.ts src/gem/__tests__/optimizeAnalyze.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(optimize): pure payload builder — prune flags + instructions health

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `optimizeScan.ts` — usage scan via scanWorkflow (+ TTL cache)

The only IO in the backend: turn all Claude transcripts into a per-artifact usage map by reusing the tested `scanWorkflow`. The installed inventory is passed as the **`project`** inventory so scanWorkflow emits every artifact including unused ones (`invocations: 0`).

**Files:**
- Create: `src/gem/optimizeScan.ts`
- Test: `src/gem/__tests__/optimizeScan.test.ts`

**Interfaces:**
- Consumes: `ConfigInventory`, `ProjectInventory` from `./types.js`; `scanWorkflow`, `allClaudeTranscripts`, `ArtifactUsage` from `./workflowScan.js`.
- Produces:
  - `function scanArtifactUsage(inv: ConfigInventory, claudeDir: string): Map<string, ArtifactUsage>` — keyed `` `${type}:${name}` `` (e.g. `"skill:qa"`, `"mcp_server:coingecko"`).
  - `async function scanArtifactUsageCached(inv: ConfigInventory, nowMs: number, claudeDir?: string): Promise<Map<string, ArtifactUsage>>` — 15s TTL; a custom `claudeDir` bypasses the cache (mirrors `scanSessionsCached`).
  - `function clearOptimizeScanCache(): void` — test helper.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/optimizeScan.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactUsage } from "../optimizeScan.js";
import type { ConfigInventory } from "../types.js";

let home: string, claudeDir: string;

function inv(): ConfigInventory {
  return {
    skills: [
      { type: "skill", name: "qa", description: "d", source: "standalone", content: "x" },
      { type: "skill", name: "never-used", description: "d", source: "standalone", content: "x" },
    ],
    mcpServers: [{ type: "mcp_server", name: "context7", transport: "stdio", config: {}, source: "user" }],
    instructions: [],
    hooks: [],
  };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "optimize-"));
  claudeDir = join(home, ".claude");
  const proj = join(claudeDir, "projects", "proj-a");
  mkdirSync(proj, { recursive: true });
  // A session that invokes Skill(qa) once and an mcp__context7__ tool once.
  writeFileSync(join(proj, "s1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:00.000Z", message: { role: "user" } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:05.000Z",
      message: { role: "assistant", model: "claude-opus-4-8", content: [
        { type: "tool_use", name: "Skill", input: { skill: "qa" } },
        { type: "tool_use", name: "mcp__context7__query-docs", input: {} },
      ] } }),
  ].join("\n") + "\n");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("scanArtifactUsage", () => {
  it("counts used skills/mcp and emits unused ones with invocations 0", () => {
    const m = scanArtifactUsage(inv(), claudeDir);
    expect(m.get("skill:qa")?.invocations).toBe(1);
    expect(m.get("skill:qa")?.lastUsedMs).toBeGreaterThan(0);
    expect(m.get("mcp_server:context7")?.invocations).toBe(1);
    expect(m.get("skill:never-used")?.invocations).toBe(0);
    expect(m.get("skill:never-used")?.lastUsedMs).toBeNull();
  });

  it("returns an all-zero map when there are no transcripts", () => {
    const empty = join(home, "empty-claude");
    const m = scanArtifactUsage(inv(), empty);
    expect(m.get("skill:qa")?.invocations).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize && npx vitest run src/gem/__tests__/optimizeScan.test.ts`
Expected: FAIL — `Cannot find module '../optimizeScan.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/gem/optimizeScan.ts`:

```typescript
// src/gem/optimizeScan.ts
//
// IO seam for GET /api/optimize: scan all Claude transcripts into a per-artifact usage
// map by reusing scanWorkflow (which already detects Skill(...) and mcp__server__ calls
// and resolves them to inventory names). The installed inventory is passed as the
// `project` inventory so scanWorkflow emits EVERY artifact, including unused ones
// (invocations: 0) — unused is exactly what the prune view needs.
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigInventory, ProjectInventory } from "./types.js";
import { scanWorkflow, allClaudeTranscripts, type ArtifactUsage } from "./workflowScan.js";

const SCAN_TTL_MS = 15_000;
let cache: { atMs: number; map: Map<string, ArtifactUsage> } | null = null;

function syntheticProject(inv: ConfigInventory): ProjectInventory {
  // Carry the installed skills/mcp/hooks as a single synthetic "project" so scanWorkflow
  // emits all of them with usage counts. Instructions are handled separately (presence-only).
  return { root: "", name: "", skills: inv.skills, mcpServers: inv.mcpServers, instructions: [], hooks: inv.hooks };
}

export function scanArtifactUsage(inv: ConfigInventory, claudeDir: string): Map<string, ArtifactUsage> {
  const paths = allClaudeTranscripts(claudeDir);
  const signal = scanWorkflow(paths, { project: syntheticProject(inv), global: { skills: [], mcpServers: [], hooks: [] } });
  const map = new Map<string, ArtifactUsage>();
  for (const a of signal.artifacts) {
    if (a.type === "skill" || a.type === "mcp_server") map.set(`${a.type}:${a.name}`, a);
  }
  return map;
}

export async function scanArtifactUsageCached(inv: ConfigInventory, nowMs: number, claudeDir?: string): Promise<Map<string, ArtifactUsage>> {
  if (claudeDir) return scanArtifactUsage(inv, claudeDir);   // custom dir bypasses cache
  const dir = join(homedir(), ".claude");
  if (cache && nowMs - cache.atMs < SCAN_TTL_MS) return cache.map;
  const map = scanArtifactUsage(inv, dir);
  cache = { atMs: nowMs, map };
  return map;
}

export function clearOptimizeScanCache(): void {
  cache = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize && npx vitest run src/gem/__tests__/optimizeScan.test.ts`
Expected: PASS.

If `mcp_server:context7` is `undefined`, the MCP name match failed — check that `matchMcpServer` resolves `context7` from `mcp__context7__query-docs` (token `context7`), which it does by substring; the inventory name must be `context7`. This is the "verify MCP naming against fixtures" risk from the spec; the test fixture covers it.

- [ ] **Step 5: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-optimize
git add src/gem/optimizeScan.ts src/gem/__tests__/optimizeScan.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(optimize): transcript usage scan via scanWorkflow + TTL cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Route definition + Zod schema in `routes.ts`

Adds the typed `optimizeRoute` the console calls, plus exported types the panel imports. Mirrors the `observeRoute` pattern exactly.

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add near the `observeRoute` definition, ~line 346)

**Interfaces:**
- Produces: `optimizeRoute` (GET `/api/optimize`), `OptimizePayloadSchema`, and exported types `OptimizePayload`, `OptimizeArtifact`, `OptimizeInstruction`, `OptimizeRange`.
- Consumes: existing `z`, `defineRoute` imports already at top of `routes.ts`.

- [ ] **Step 1: Write the schema + route**

In `packages/console/src/api/routes.ts`, immediately after the `observeRoute` definition, add:

```typescript
// ── Optimize (Plan 1: local prune + instructions health) ──
const OptimizeArtifactSchema = z.object({
  name: z.string(),
  type: z.enum(["skill", "mcp"]),
  source: z.string(),
  contextTokens: z.number(),
  uses: z.number(),
  lastUsedMs: z.number().nullable(),
  prune: z.boolean(),
  change: z.object({ file: z.string(), key: z.string() }),
});
const OptimizeInstructionSchema = z.object({
  name: z.string(),
  source: z.string(),
  contextTokens: z.number(),
  lines: z.number(),
  flags: z.array(z.enum(["oversized", "very-long", "duplicate-lines"])),
});
const OptimizePayloadSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]),
  artifacts: z.array(OptimizeArtifactSchema),
  instructions: z.array(OptimizeInstructionSchema),
});
export type OptimizeArtifact = z.infer<typeof OptimizeArtifactSchema>;
export type OptimizeInstruction = z.infer<typeof OptimizeInstructionSchema>;
export type OptimizePayload = z.infer<typeof OptimizePayloadSchema>;
export type OptimizeRange = OptimizePayload["range"];

export const optimizeRoute = defineRoute("GET", "/api/optimize", {
  query: z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional() }),
  response: OptimizePayloadSchema,
});
```

- [ ] **Step 2: Typecheck the console package**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize/packages/console && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (the new schema/types compile).

- [ ] **Step 3: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-optimize
git add packages/console/src/api/routes.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(optimize): GET /api/optimize route + payload schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Controller handler

Wires the endpoint: introspect installed config, scan usage (cached), build the payload. Mirrors the `observe` handler.

**Files:**
- Modify: `src/gem.controller.ts` (add handler near the `observe` handler ~line 171; add imports)

**Interfaces:**
- Consumes: `introspectConfig` from `./gem/introspect.js`; `scanArtifactUsageCached` from `./gem/optimizeScan.js`; `buildOptimizePayload`, `type OptimizeRange` from `./gem/optimizeAnalyze.js`.
- The backend builds the same object shape the console `OptimizePayloadSchema` validates. To keep the controller's own Zod response schema in sync, define `OptimizeQuerySchema` / `OptimizePayloadSchema` locally next to the existing `ObserveQuerySchema` (controllers in this file already declare local Zod schemas — follow that pattern).

- [ ] **Step 1: Add the local Zod schemas + handler**

At the top of `src/gem.controller.ts`, add to the existing imports:

```typescript
import { scanArtifactUsageCached } from "./gem/optimizeScan.js";
import { buildOptimizePayload, type OptimizeRange } from "./gem/optimizeAnalyze.js";
```

Near `ObserveQuerySchema` / `ObservePayloadSchema`, add matching local schemas (copy the shapes from Task 3 — the response schema must match `OptimizePayload`):

```typescript
const OptimizeQuerySchema = z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional() });
const OptimizeArtifactSchema = z.object({
  name: z.string(), type: z.enum(["skill", "mcp"]), source: z.string(),
  contextTokens: z.number(), uses: z.number(), lastUsedMs: z.number().nullable(),
  prune: z.boolean(), change: z.object({ file: z.string(), key: z.string() }),
});
const OptimizeInstructionSchema = z.object({
  name: z.string(), source: z.string(), contextTokens: z.number(), lines: z.number(),
  flags: z.array(z.enum(["oversized", "very-long", "duplicate-lines"])),
});
const OptimizePayloadSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]),
  artifacts: z.array(OptimizeArtifactSchema),
  instructions: z.array(OptimizeInstructionSchema),
});
```

Inside the `GemController` class, next to the `observe` handler, add:

```typescript
@get("/optimize", { query: OptimizeQuerySchema, response: OptimizePayloadSchema })
async optimize(input: { query: z.infer<typeof OptimizeQuerySchema> }): Promise<z.infer<typeof OptimizePayloadSchema>> {
  const range: OptimizeRange = input.query.range ?? "30d";
  const now = Date.now();
  const inv = introspectConfig();
  const usage = await scanArtifactUsageCached(inv, now);
  return buildOptimizePayload(inv, usage, range, now);
}
```

Note: `introspectConfig` is already imported in this file (used by other handlers). If not, add `import { introspectConfig } from "./gem/introspect.js";`.

- [ ] **Step 2: Build + run the full backend test suite**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize && npm test`
Expected: `tsc -b` compiles with no errors, and all tests (including Tasks 1–2) pass. No regressions.

- [ ] **Step 3: Smoke-test the endpoint shape**

Start the server the way the project does (check `package.json` scripts for the dev/serve command, e.g. `npm run dev`), then:

Run: `curl -s 'http://localhost:<port>/api/optimize?range=all' | head -c 600`
Expected: JSON with `range`, `artifacts` (array; unused ones have `prune: true`), and `instructions` (array). If the server isn't easily runnable here, this step may be deferred to Task 6 manual verification — note it, don't skip silently.

- [ ] **Step 4: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-optimize
git add src/gem.controller.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(optimize): wire GET /api/optimize controller handler

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Optimize panel (frontend)

The React panel: a range selector + three sections (prune table, instructions table, and a placeholder Discover section marked "coming next"). Registers as the second tab in the Observe group.

**Files:**
- Create: `packages/console/src/panels/Optimize/index.tsx`
- Create: `packages/console/src/panels/Optimize/Dashboard.tsx`
- Modify: `packages/console/src/pages.tsx`
- Modify: `packages/console/src/shell/theme.css` (append `opt-*` styles)

**Interfaces:**
- Consumes: `optimizeRoute`, `makeClient`, `type OptimizePayload`, `type OptimizeRange` from `../../api/routes.js`; `defineConsolePage` from `../../registry.js`; `fmtTokens` from `../Observe/data.js`.
- Produces: `export const optimizePage`.

- [ ] **Step 1: Create the panel container**

Create `packages/console/src/panels/Optimize/index.tsx`:

```tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { optimizeRoute, makeClient, type OptimizePayload, type OptimizeRange } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";

export function Optimize({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<OptimizePayload | null>(null);
  const [range, setRange] = useState<OptimizeRange>("30d");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    optimizeRoute.call(makeClient(apiBase), { query: { range } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, range]);

  if (error) return <div className="opt"><p className="obs-error">Couldn't load Optimize: {error}</p></div>;
  if (!data) return <div className="opt"><p className="obs-loading">Loading…</p></div>;
  return <Dashboard data={data} range={range} onRange={setRange} pending={pending} />;
}

export const optimizePage = defineConsolePage({
  id: "optimize", title: "Optimize", icon: "⚡", order: 6, group: "observe",
  route: "#/optimize", component: Optimize,
});
```

Note: `order: 6` places it after `observePage` (`order: 5`) in the Observe group.

- [ ] **Step 2: Create the Dashboard renderer**

Create `packages/console/src/panels/Optimize/Dashboard.tsx`:

```tsx
import { fmtTokens } from "../Observe/data.js";
import type { OptimizePayload, OptimizeRange } from "../../api/routes.js";

const RANGES: OptimizeRange[] = ["today", "7d", "30d", "all"];

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function Dashboard({ data, range, onRange, pending }: {
  data: OptimizePayload;
  range: OptimizeRange;
  onRange: (r: OptimizeRange) => void;
  pending: boolean;
}) {
  const prunable = data.artifacts.filter((a) => a.prune);
  const savings = prunable.reduce((acc, a) => acc + a.contextTokens, 0);

  return (
    <div className="opt">
      <div className="opt-head">
        <div className="opt-ranges">
          {RANGES.map((r) => (
            <button key={r} className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>{r}</button>
          ))}
        </div>
        {pending && <span className="obs-muted">refreshing…</span>}
      </div>

      <section className="opt-section">
        <h3>Prune — installed but unused <span className="obs-muted">({prunable.length}, ~{fmtTokens(savings)} est. context saved)</span></h3>
        <p className="obs-muted opt-note">Context tokens are estimates (chars/4). Skills count name+description; MCP counts launch config (tool schemas add more at runtime). Recommend-only — nothing is changed for you.</p>
        <table className="obs-table">
          <thead><tr><th>artifact</th><th>type</th><th>source</th><th>est. ctx</th><th>uses</th><th>last used</th><th>to disable</th></tr></thead>
          <tbody>
            {data.artifacts.map((a) => (
              <tr key={a.type + ":" + a.name} className={a.prune ? "opt-prune" : ""}>
                <td>{a.name}</td>
                <td><span className="obs-chip">{a.type}</span></td>
                <td className="obs-muted">{a.source}</td>
                <td>{fmtTokens(a.contextTokens)}</td>
                <td>{a.uses}</td>
                <td className="obs-muted">{a.lastUsedMs ? utcDay(a.lastUsedMs) : "never"}</td>
                <td><code className="opt-change" title={`${a.change.file} → ${a.change.key}`}>{a.prune ? a.change.key : "—"}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="opt-section">
        <h3>Instructions health <span className="obs-muted">(loaded every session)</span></h3>
        <table className="obs-table">
          <thead><tr><th>file</th><th>source</th><th>est. ctx / session</th><th>lines</th><th>flags</th></tr></thead>
          <tbody>
            {data.instructions.map((i) => (
              <tr key={i.source + ":" + i.name}>
                <td>{i.name}</td>
                <td className="obs-muted">{i.source}</td>
                <td>{fmtTokens(i.contextTokens)}</td>
                <td>{i.lines}</td>
                <td>{i.flags.length ? i.flags.map((f) => <span key={f} className="opt-flag">{f}</span>) : <span className="obs-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="opt-section opt-soon">
        <h3>Discover — recommended for you</h3>
        <p className="obs-muted">Ranked skill recommendations from skills.sh, matched to your workflows. Coming in the next update.</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Register the page**

In `packages/console/src/pages.tsx`, add the import and array entry:

```typescript
import { optimizePage } from "./panels/Optimize/index.js";
```

Add `optimizePage` to the `pages` array (place it right after `observePage`):

```typescript
export const pages: ConsolePage[] = [observePage, optimizePage, curatePage, materializePage, workspacesPage, getGemsPage, settingsPage, receivedPage, deployPage];
```

- [ ] **Step 4: Add styles**

Append to `packages/console/src/shell/theme.css`:

```css
/* Optimize panel */
.opt { padding: 16px; }
.opt-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.opt-ranges { display: flex; gap: 4px; }
.opt-section { margin-bottom: 28px; }
.opt-section h3 { margin: 0 0 6px; font-size: 14px; }
.opt-note { margin: 0 0 10px; font-size: 12px; }
.opt-prune td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.opt-change { font-size: 11px; color: var(--accent); }
.opt-flag { display: inline-block; padding: 1px 6px; margin-right: 4px; border-radius: 4px; font-size: 11px; background: var(--raised); border: 1px solid var(--line); }
.opt-soon { opacity: 0.7; }
```

Note: `--accent`, `--raised`, `--line` are existing theme variables (used by `.obs-*` styles). If `color-mix` is unsupported in the build target, fall back to a fixed translucent color.

- [ ] **Step 5: Typecheck + build the console**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-optimize/packages/console && npx tsc -p tsconfig.json --noEmit && node build-client.mjs`
Expected: no type errors; client bundle builds.

- [ ] **Step 6: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-optimize
git add packages/console/src/panels/Optimize packages/console/src/pages.tsx packages/console/src/shell/theme.css
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(optimize): Optimize panel — prune + instructions health UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification

Confirm the tab renders with real local data and the numbers are sane.

**Files:** none (verification only).

- [ ] **Step 1: Run the app and open the tab**

Start the server (project dev command), open the console at `/`, and click the **Optimize** tab under Observe.
Expected: the prune table lists your installed skills/MCP; ones you've never used show `prune` highlight + a `to disable` hint; the instructions table shows your global CLAUDE.md with an `est. ctx / session` value and any `oversized`/`very-long` flags.

- [ ] **Step 2: Sanity-check against a known artifact**

Pick a skill you know you've used recently and one you've never used. Verify the used one is NOT highlighted (and shows a non-zero `uses`) and the unused one IS highlighted with `uses: 0`, `last used: never`.
Expected: matches reality. If a used skill shows `uses: 0`, the name match in `scanWorkflow` failed for that skill — capture the skill name + its `Skill(...)` evidence and investigate the matcher (do not patch around it).

- [ ] **Step 3: Verify the disable hints are real (spec risk #4)**

For one plugin row and one standalone-skill row, confirm the suggested key actually exists in the live Claude Code settings schema (`skillOverrides`, `enabledPlugins`). If a key name is wrong, fix `changeHint` in `optimizeAnalyze.ts` (and its test) to the correct key, then re-run `npm test`.
Expected: the hints name real settings keys.

- [ ] **Step 4: Final full test run + push**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-optimize
npm test
git push -u origin feat/optimize-tab
```
Expected: all green; branch pushed. (Open a PR only when the user asks.)

---

## Self-Review

**Spec coverage:**
- Panel placement under Observe group → Task 5 (`optimizePage`, `group: "observe"`, registered in `pages.tsx`). ✓
- Prune (installed × used, reuse scanWorkflow) → Tasks 1–2. ✓
- Context-cost estimate (chars/4, labeled) → Task 1 (`estTokens`) + Task 5 (UI note). ✓
- Reversible change-hint mapping per source → Task 1 (`changeHint`) + tests. ✓
- Plugin dedup → Task 1 (`byPlugin` collapse) + test. ✓
- Instructions health (weight + bloat flags) → Task 1 (`instructionHealth`) + tests + Task 5 table. ✓
- `GET /api/optimize` endpoint + schema → Tasks 3–4. ✓
- Range rule via `lastUsedMs` vs `rangeStart` → Task 1 + tests. ✓
- Codex usage not mis-flagged → v1 scans Claude transcripts only; Codex skills/MCP get `uses: 0`. **Gap:** the plan does not special-case Codex artifacts with a "not tracked" note in the UI. Acceptable for v1 (they appear as unused) but noted; a follow-up can add the badge. The spec lists this as an out-of-scope follow-up, so no task is required.
- Discover (Plan 2) and semantic critique (Plan 3) → intentionally NOT in this plan; a placeholder "coming next" section appears in Task 5.

**Placeholder scan:** No TBD/TODO; every code step contains complete code. ✓

**Type consistency:** `OptimizePayload`/`OptimizeArtifact`/`OptimizeInstruction`/`OptimizeRange` are defined once in Task 1 (backend) and mirrored in Task 3 (console Zod) and Task 4 (controller Zod). Usage-map key `${type}:${name}` is consistent across Tasks 1, 2. `changeHint` keys in Task 1 match the assertions in its test. ✓

**Known risk carried into execution:** the MCP context-token estimate is a floor (launch config, not runtime tool schemas) — labeled in the UI (Task 5 note). The disable-key names are verified live in Task 6 Step 3.
