# Workflow-Aware Gem Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project "Analyze workflow" feature that reads a project's session transcripts, computes a deterministic usage signal, asks a local ACP coding agent to recommend a Gem composition, and returns a pre-checked `GemSelection` the existing `/api/gem` flow consumes.

**Architecture:** Two new pure-ish modules — `workflowScan.ts` (deterministic transcript → `WorkflowSignal`) and `acpRecommender.ts` (signal+inventory → `GemRecommendation`, via a ported, trimmed ACP session with a `connectFn` seam and deterministic fallback) — plus one decorator endpoint `POST /api/workflow/analyze` and a UI button. The deterministic scan is the trust boundary; the agent only ranks/clusters/explains and its output is re-validated against the inventory.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Zod, `@agentback/openapi` decorators, vitest (runs **compiled** tests from `dist/**/__tests__/**/*.test.js`), `@agentclientprotocol/sdk` (new dep).

## Global Constraints

- ESM with NodeNext: every relative import ends in `.js` (e.g. `import { x } from "./types.js"`).
- Tests run against compiled output: `pnpm test` = `tsc -b && vitest run`. After any file rename/move, `rm -rf dist` before testing (stale dist persists deleted tests).
- Build fixtures at runtime in `os.tmpdir()` subdirs (fixture files under `src/` are NOT copied to `dist/`). Clean them up in `afterAll`.
- Scope is **Claude flavor only** for v1. Codex/Hermes → empty signal + note.
- v1 returns a **single JSON response** (no SSE — agentgem has no streaming primitive).
- The agent may only return inventory artifact names; any name absent from the inventory is dropped and logged. The inventory is authoritative.
- Recommender must run the agent in `'plan'` permission mode with an empty `mcpServers` list, and must never fail the request — any agent error → deterministic fallback with `degraded:true`.
- Project artifacts are namespaced: a selection for one project root is `{ projects: { [root]: ProjectSelection } }`. Instructions are a boolean (`includeInstructions`), not a named include. Hook names are the exact (mangled) inventory names.
- Spec: `docs/superpowers/specs/2026-06-24-workflow-aware-gem-recommendation-design.md`.

---

### Task 1: `WorkflowSignal` types + Claude transcript resolver

**Files:**
- Create: `src/gem/workflowScan.ts`
- Test: `src/gem/__tests__/workflowScan.test.ts`

**Interfaces:**
- Consumes: `ArtifactType` from `./types.js`.
- Produces:
  - `interface ArtifactUsage { type: ArtifactType; name: string; root: string | null; invocations: number; sessionsUsedIn: number; lastUsedMs: number | null; confidence: "high" | "low"; evidence?: string }`
  - `interface WorkflowSignal { root: string; flavor: "claude" | "codex"; sessions: { scanned: number; firstMs: number; lastMs: number; spanDays: number }; artifacts: ArtifactUsage[]; unresolved: { name: string; kind: ArtifactType | "builtin"; count: number }[]; coOccurrence: { a: string; b: string; sessions: number }[]; notes: string[] }`
  - `function claudeTranscriptsForCwd(claudeDir: string, cwd: string): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/workflowScan.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptsForCwd } from "../workflowScan.js";

let claudeDir: string;
const PROJ = "/Users/me/work/app";

beforeAll(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "wfscan-"));
  const projectsDir = join(claudeDir, "projects");
  // Two folders whose sessions belong to PROJ, one that does not.
  for (const [folder, cwd, files] of [
    ["enc-a", PROJ, ["s1.jsonl", "s2.jsonl"]],
    ["enc-b", PROJ, ["s3.jsonl"]],
    ["enc-c", "/Users/me/other", ["s4.jsonl"]],
  ] as const) {
    const dir = join(projectsDir, folder);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd }) + "\n");
  }
});
afterAll(() => rmSync(claudeDir, { recursive: true, force: true }));

describe("claudeTranscriptsForCwd", () => {
  it("returns every .jsonl whose session cwd matches, across folders", () => {
    const paths = claudeTranscriptsForCwd(claudeDir, PROJ).map((p) => p.split("/").pop()).sort();
    expect(paths).toEqual(["s1.jsonl", "s2.jsonl", "s3.jsonl"]);
  });

  it("returns [] for a missing projects dir", () => {
    expect(claudeTranscriptsForCwd(join(claudeDir, "nope"), PROJ)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- workflowScan`
Expected: FAIL — `claudeTranscriptsForCwd` is not defined / cannot find module `../workflowScan.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/workflowScan.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactType } from "./types.js";

export interface ArtifactUsage {
  type: ArtifactType;
  name: string;
  root: string | null;            // project root this artifact belongs to (null = global)
  invocations: number;
  sessionsUsedIn: number;
  lastUsedMs: number | null;
  confidence: "high" | "low";
  evidence?: string;
}

export interface WorkflowSignal {
  root: string;
  flavor: "claude" | "codex";
  sessions: { scanned: number; firstMs: number; lastMs: number; spanDays: number };
  artifacts: ArtifactUsage[];
  unresolved: { name: string; kind: ArtifactType | "builtin"; count: number }[];
  coOccurrence: { a: string; b: string; sessions: number }[];
  notes: string[];
}

// A session's cwd never changes; read just enough lines to find it.
function sessionCwd(file: string): string | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.cwd === "string") return rec.cwd;
    } catch { /* skip malformed */ }
  }
  return null;
}

/**
 * Every Claude transcript whose session cwd === `cwd`. The folder-name encoding
 * under ~/.claude/projects is lossy, so we scan ALL folders and filter by the
 * real cwd parsed from each session (not by folder name).
 */
export function claudeTranscriptsForCwd(claudeDir: string, cwd: string): string[] {
  const projectsDir = join(claudeDir, "projects");
  let folders: import("node:fs").Dirent[];
  try { folders = readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      if (sessionCwd(path) === cwd) out.push(path);
    }
  }
  return out;
}

// statSync mtime, 0 on error — used later for recency.
export function safeMtime(file: string): number {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- workflowScan`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/workflowScan.ts src/gem/__tests__/workflowScan.test.ts
git commit -m "feat(workflow): WorkflowSignal types + Claude transcript resolver"
```

---

### Task 2: `scanWorkflow` — skill + MCP usage with availability-vs-usage guard

**Files:**
- Modify: `src/gem/workflowScan.ts`
- Test: `src/gem/__tests__/workflowScan.test.ts`

**Interfaces:**
- Consumes: `ProjectInventory` from `./types.js`; `ArtifactUsage`, `WorkflowSignal` from Task 1.
- Produces: `function scanWorkflow(paths: string[], inventory: ProjectInventory): WorkflowSignal`

**Key correctness rule:** only count tool uses that appear inside an **assistant** message's `content[]` as `{ type: "tool_use", name, input }`. The system-prompt tool catalog lists `mcp__…` names too — those must NOT be counted. MCP server token: take a `tool_use` name `mcp__<server>__<tool>`, strip the `mcp__` prefix and the trailing `__<tool>`, then match an inventory MCP server whose name is a substring of (or equals, normalized) that server token. Skills: `tool_use` name `"Skill"`, server-agnostic, with `input.skill` = the skill id → match `skills[].name`.

- [ ] **Step 1: Write the failing test** (append to the existing file)

```ts
import { scanWorkflow } from "../workflowScan.js";
import type { ProjectInventory } from "../types.js";

const inventory: ProjectInventory = {
  root: PROJ,
  name: "app",
  skills: [{ type: "skill", name: "qa", source: "project", content: "x" }],
  mcpServers: [{ type: "mcp_server", name: "context7", transport: "stdio", config: {} }],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [],
};

function assistantToolUse(name: string, input: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
}

describe("scanWorkflow skills + mcp", () => {
  it("counts real tool_use invocations and ignores the system-prompt catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfscan2-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [
      // a system record that merely lists the MCP tool name in text — must NOT count
      JSON.stringify({ type: "system", content: 'available: mcp__plugin_context7_context7__query-docs' }),
      assistantToolUse("mcp__plugin_context7_context7__query-docs"),
      assistantToolUse("mcp__plugin_context7_context7__resolve-library-id"),
      assistantToolUse("Skill", { skill: "qa" }),
      assistantToolUse("Bash"),                                   // builtin → unresolved
      assistantToolUse("mcp__plugin_unknownsrv__do"),             // not in inventory → unresolved
    ].join("\n") + "\n");

    const sig = scanWorkflow([file], inventory);
    const byName = Object.fromEntries(sig.artifacts.map((a) => [a.name, a]));
    expect(byName["context7"].invocations).toBe(2);      // two mcp tools, same server
    expect(byName["context7"].confidence).toBe("high");
    expect(byName["qa"].invocations).toBe(1);
    expect(byName["context7"].sessionsUsedIn).toBe(1);
    // installed-but-unused stays at 0, not dropped:
    expect(sig.artifacts.find((a) => a.name === "CLAUDE.md")).toBeTruthy();
    // unresolved buckets builtins + unknown servers
    const unresolved = Object.fromEntries(sig.unresolved.map((u) => [u.name, u]));
    expect(unresolved["Bash"].kind).toBe("builtin");
    expect(unresolved["unknownsrv"].kind).toBe("mcp_server");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- workflowScan`
Expected: FAIL — `scanWorkflow` is not defined.

- [ ] **Step 3: Write minimal implementation** (append to `workflowScan.ts`)

```ts
import type { ProjectInventory } from "./types.js";

// "mcp__plugin_context7_context7__query-docs" -> "plugin_context7_context7"
function mcpServerToken(toolName: string): string {
  const body = toolName.slice("mcp__".length);
  const idx = body.lastIndexOf("__");
  return idx >= 0 ? body.slice(0, idx) : body;
}

// Match an inventory MCP server to a runtime server token (lossy namespacing):
// equal, or the inventory name appears as a token segment / substring.
function matchMcpServer(token: string, servers: { name: string }[]): string | null {
  const norm = token.toLowerCase();
  for (const s of servers) {
    const n = s.name.toLowerCase();
    if (norm === n || norm.includes(n)) return s.name;
  }
  return null;
}

interface Acc { invocations: number; sessions: Set<string>; lastMs: number; evidence?: string }

export function scanWorkflow(paths: string[], inventory: ProjectInventory): WorkflowSignal {
  const used = new Map<string, { type: ArtifactType; acc: Acc }>(); // key = inventory name
  const unresolved = new Map<string, { kind: ArtifactType | "builtin"; count: number }>();
  const perSession: { ms: number; names: Set<string> }[] = [];
  const notes: string[] = [];
  let firstMs = Infinity, lastMs = 0;

  const touch = (name: string, type: ArtifactType, ms: number, sessionId: string, evidence?: string) => {
    let e = used.get(name);
    if (!e) { e = { type, acc: { invocations: 0, sessions: new Set(), lastMs: 0, evidence } }; used.set(name, e); }
    e.acc.invocations++;
    e.acc.sessions.add(sessionId);
    e.acc.lastMs = Math.max(e.acc.lastMs, ms);
  };

  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const ms = safeMtime(path);
    firstMs = Math.min(firstMs, ms); lastMs = Math.max(lastMs, ms);
    const sessionNames = new Set<string>();
    let bad = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { bad++; continue; }
      // Only ASSISTANT messages carry real tool_use invocations.
      const role = rec?.message?.role ?? rec?.role;
      const content = rec?.message?.content;
      if (role !== "assistant" || !Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const name: string = block.name;
        if (name === "Skill" && typeof block.input?.skill === "string") {
          const skill = block.input.skill as string;
          const match = inventory.skills.find((s) => s.name === skill || skill.endsWith(`:${s.name}`));
          if (match) { touch(match.name, "skill", ms, path, `Skill(${skill})`); sessionNames.add(match.name); }
          else bumpUnresolved(unresolved, skill, "builtin");
        } else if (name.startsWith("mcp__")) {
          const server = matchMcpServer(mcpServerToken(name), inventory.mcpServers);
          if (server) { touch(server, "mcp_server", ms, path, name); sessionNames.add(server); }
          else bumpUnresolved(unresolved, mcpServerToken(name), "mcp_server");
        } else {
          bumpUnresolved(unresolved, name, "builtin");
        }
      }
    }
    if (bad) notes.push(`${bad} unparseable line(s) skipped in ${path.split("/").pop()}`);
    perSession.push({ ms, names: sessionNames });
  }

  // Assemble artifacts: every inventory item appears (0 = installed, unused).
  const artifacts: ArtifactUsage[] = [];
  const add = (type: ArtifactType, name: string, confidence: "high" | "low") => {
    const e = used.get(name);
    artifacts.push({
      type, name, root: inventory.root,
      invocations: e?.acc.invocations ?? 0,
      sessionsUsedIn: e?.acc.sessions.size ?? 0,
      lastUsedMs: e?.acc.lastMs || null,
      confidence,
      evidence: e?.acc.evidence,
    });
  };
  for (const s of inventory.skills) add("skill", s.name, "high");
  for (const m of inventory.mcpServers) add("mcp_server", m.name, "high");

  return {
    root: inventory.root,
    flavor: "claude",
    sessions: {
      scanned: paths.length,
      firstMs: firstMs === Infinity ? 0 : firstMs,
      lastMs,
      spanDays: lastMs && firstMs !== Infinity ? Math.round((lastMs - firstMs) / 86_400_000) : 0,
    },
    artifacts,
    unresolved: [...unresolved.entries()].map(([name, v]) => ({ name, kind: v.kind, count: v.count })),
    coOccurrence: [],   // filled in Task 3
    notes,
  };
}

function bumpUnresolved(map: Map<string, { kind: ArtifactType | "builtin"; count: number }>, name: string, kind: ArtifactType | "builtin") {
  const e = map.get(name);
  if (e) e.count++; else map.set(name, { kind, count: 1 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- workflowScan`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/workflowScan.ts src/gem/__tests__/workflowScan.test.ts
git commit -m "feat(workflow): scanWorkflow skill+mcp counting with catalog guard"
```

---

### Task 3: `scanWorkflow` — hooks, instructions, co-occurrence, empty/malformed

**Files:**
- Modify: `src/gem/workflowScan.ts`
- Test: `src/gem/__tests__/workflowScan.test.ts`

**Interfaces:**
- Produces: same `scanWorkflow` signature, now also emitting `hook`/`instructions` artifacts, `coOccurrence`, and an empty-scan note.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("scanWorkflow hooks, instructions, co-occurrence", () => {
  const invWithHook: ProjectInventory = {
    ...inventory,
    hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [{ command: "guard.sh" }] }, source: "project" }],
  };

  it("flags hooks (low confidence) and instructions (presence), and pairs co-occurrence", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfscan3-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [
      assistantToolUse("Skill", { skill: "qa" }),
      assistantToolUse("mcp__plugin_context7_context7__query-docs"),
      JSON.stringify({ type: "user", content: "PreToolUse:Bash [guard.sh] hook success: ok" }),
    ].join("\n") + "\n");

    const sig = scanWorkflow([file], invWithHook);
    const byName = Object.fromEntries(sig.artifacts.map((a) => [a.name, a]));
    expect(byName["PreToolUse · Bash"].confidence).toBe("low");
    expect(byName["PreToolUse · Bash"].invocations).toBeGreaterThanOrEqual(1);
    expect(byName["CLAUDE.md"].type).toBe("instructions");
    expect(byName["CLAUDE.md"].invocations).toBe(1);            // present in 1 session
    // qa and context7 fired in the same session -> a co-occurrence pair
    const pair = sig.coOccurrence.find((c) => [c.a, c.b].includes("qa") && [c.a, c.b].includes("context7"));
    expect(pair?.sessions).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty scan yields a valid zero signal with a note", () => {
    const sig = scanWorkflow([], inventory);
    expect(sig.sessions.scanned).toBe(0);
    expect(sig.artifacts.every((a) => a.invocations === 0)).toBe(true);
    expect(sig.notes.some((n) => /no transcripts/i.test(n))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- workflowScan`
Expected: FAIL — hooks/instructions absent from `artifacts`, `coOccurrence` empty, no empty-scan note.

- [ ] **Step 3: Write minimal implementation**

In `scanWorkflow`, inside the per-line loop, after the assistant-message block, add hook detection on any record's text:

```ts
      // Hook firing is low-confidence: hooks aren't tool_use, they surface as
      // injected "... hook success:" / hook-event text. Match by event + command basename.
      const flat = typeof rec === "string" ? rec : JSON.stringify(rec);
      if (flat.includes("hook success") || /Hook\b/.test(flat)) {
        for (const h of inventory.hooks) {
          const cmd = firstHookCommand(h.config);
          const base = cmd ? cmd.split("/").pop()! : "";
          if ((h.event && flat.includes(h.event)) || (base && flat.includes(base))) {
            touch(h.name, "hook", ms, path); sessionNames.add(h.name);
          }
        }
      }
```

Add the helper near the other helpers:

```ts
function firstHookCommand(config: Record<string, unknown>): string | null {
  const hooks = (config?.hooks as Array<Record<string, unknown>>) ?? [];
  for (const h of hooks) if (typeof h.command === "string") return h.command;
  return null;
}
```

Replace the artifact-assembly block to also add hooks + instructions and compute co-occurrence:

```ts
  for (const s of inventory.skills) add("skill", s.name, "high");
  for (const m of inventory.mcpServers) add("mcp_server", m.name, "high");
  for (const h of inventory.hooks) add("hook", h.name, "low");
  // Instructions are presence-only: loaded every session, never "invoked".
  for (const ins of inventory.instructions) {
    artifacts.push({
      type: "instructions", name: ins.name, root: inventory.root,
      invocations: paths.length, sessionsUsedIn: paths.length,
      lastUsedMs: lastMs || null, confidence: "low",
    });
  }

  // Co-occurrence: count sessions in which each unordered pair both fired.
  const pairCounts = new Map<string, number>();
  for (const s of perSession) {
    const names = [...s.names].sort();
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const key = `${names[i]} ${names[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
  }
  const coOccurrence = [...pairCounts.entries()].map(([k, sessions]) => {
    const [a, b] = k.split(" ");
    return { a, b, sessions };
  });
```

And in the returned object, use the computed `coOccurrence` and add an empty note:

```ts
    coOccurrence,
    notes: paths.length === 0 ? [...notes, "no transcripts found for this project"] : notes,
```

(Also: the instructions push must run regardless of usage; the existing `add()` only covers used-or-not via `used` map, instructions never appear in `used`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- workflowScan`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/workflowScan.ts src/gem/__tests__/workflowScan.test.ts
git commit -m "feat(workflow): hooks, instructions, co-occurrence, empty-scan handling"
```

---

### Task 4: Recommendation types, selection mapping, validation + deterministic fallback

**Files:**
- Create: `src/gem/acpRecommender.ts`
- Test: `src/gem/__tests__/acpRecommender.test.ts`

**Interfaces:**
- Consumes: `WorkflowSignal`, `ArtifactUsage` from `./workflowScan.js`; `ProjectInventory` from `./types.js`; `GemSelection`, `ProjectSelection` from `./buildGem.js`.
- Produces:
  - `interface RecommendedItem { type: ArtifactType; name: string; reason: string }`
  - `interface GemRecommendation { name: string; description: string; root: string; includeInstructions: boolean; include: RecommendedItem[]; exclude: RecommendedItem[]; gaps: string[]; confidence: "high" | "medium" | "low" }`
  - `function recommendationToSelection(rec: GemRecommendation): GemSelection`
  - `function deterministicRecommendation(signal: WorkflowSignal): GemRecommendation`
  - `function validateRecommendation(raw: unknown, inventory: ProjectInventory, signal: WorkflowSignal): GemRecommendation`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/acpRecommender.test.ts
import { describe, it, expect } from "vitest";
import { recommendationToSelection, deterministicRecommendation, validateRecommendation } from "../acpRecommender.js";
import type { WorkflowSignal } from "../workflowScan.js";
import type { ProjectInventory } from "../types.js";

const ROOT = "/Users/me/work/app";
const inventory: ProjectInventory = {
  root: ROOT, name: "app",
  skills: [{ type: "skill", name: "qa", source: "project", content: "x" }],
  mcpServers: [{ type: "mcp_server", name: "context7", transport: "stdio", config: {} }],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", config: { hooks: [] }, source: "project" }],
};
const signal: WorkflowSignal = {
  root: ROOT, flavor: "claude",
  sessions: { scanned: 3, firstMs: 1, lastMs: 2, spanDays: 1 },
  artifacts: [
    { type: "skill", name: "qa", root: ROOT, invocations: 5, sessionsUsedIn: 3, lastUsedMs: 2, confidence: "high" },
    { type: "mcp_server", name: "context7", root: ROOT, invocations: 4, sessionsUsedIn: 2, lastUsedMs: 2, confidence: "high" },
    { type: "mcp_server", name: "unusedsrv", root: ROOT, invocations: 0, sessionsUsedIn: 0, lastUsedMs: null, confidence: "high" },
    { type: "instructions", name: "CLAUDE.md", root: ROOT, invocations: 3, sessionsUsedIn: 3, lastUsedMs: 2, confidence: "low" },
  ],
  unresolved: [{ name: "playwright", kind: "mcp_server", count: 9 }],
  coOccurrence: [], notes: [],
};

describe("deterministicRecommendation", () => {
  it("includes high-confidence used artifacts, excludes the unused one", () => {
    const rec = deterministicRecommendation(signal);
    expect(rec.include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
    expect(rec.exclude.map((i) => i.name)).toContain("unusedsrv");
    expect(rec.includeInstructions).toBe(true);    // instructions present
    expect(rec.gaps).toContain("playwright");
    expect(rec.root).toBe(ROOT);
  });
});

describe("recommendationToSelection", () => {
  it("maps to a project-namespaced GemSelection with instructions as a boolean", () => {
    const rec = deterministicRecommendation(signal);
    const sel = recommendationToSelection(rec) as any;
    expect(sel.projects[ROOT].skills).toEqual(["qa"]);
    expect(sel.projects[ROOT].mcpServers).toEqual(["context7"]);
    expect(sel.projects[ROOT].includeInstructions).toBe(true);
    expect("instructions" in sel.projects[ROOT]).toBe(false);   // never a named include
  });
});

describe("validateRecommendation", () => {
  it("drops hallucinated names not in the inventory", () => {
    const rec = validateRecommendation(
      { name: "G", description: "d", include: [{ type: "skill", name: "qa", reason: "used" }, { type: "skill", name: "ghost", reason: "made up" }], confidence: "high" },
      inventory, signal,
    );
    expect(rec.include.map((i) => i.name)).toEqual(["qa"]);
    expect(rec.root).toBe(ROOT);
  });

  it("falls back to deterministic when raw is junk", () => {
    const rec = validateRecommendation("not json at all", inventory, signal);
    expect(rec.include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- acpRecommender`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/acpRecommender.ts
import type { ArtifactType, ProjectInventory } from "./types.js";
import type { WorkflowSignal } from "./workflowScan.js";
import type { GemSelection, ProjectSelection } from "./buildGem.js";

export interface RecommendedItem { type: ArtifactType; name: string; reason: string }
export interface GemRecommendation {
  name: string;
  description: string;
  root: string;
  includeInstructions: boolean;
  include: RecommendedItem[];
  exclude: RecommendedItem[];
  gaps: string[];
  confidence: "high" | "medium" | "low";
}

const SELECTABLE: ArtifactType[] = ["skill", "mcp_server", "hook"]; // instructions is a boolean

/** Default ranking when no agent is available (or it failed/returned junk). */
export function deterministicRecommendation(signal: WorkflowSignal): GemRecommendation {
  const include: RecommendedItem[] = [];
  const exclude: RecommendedItem[] = [];
  let includeInstructions = false;
  for (const a of signal.artifacts) {
    if (a.type === "instructions") { if (a.invocations > 0) includeInstructions = true; continue; }
    if (!SELECTABLE.includes(a.type)) continue;
    if (a.invocations > 0 && a.confidence === "high")
      include.push({ type: a.type, name: a.name, reason: `${a.invocations} use(s) across ${a.sessionsUsedIn} session(s)` });
    else
      exclude.push({ type: a.type, name: a.name, reason: a.invocations === 0 ? "installed but never used" : "low-confidence signal" });
  }
  return {
    name: signal.root.split("/").pop() || "workflow",
    description: `Recommended from ${signal.sessions.scanned} session(s) of usage.`,
    root: signal.root,
    includeInstructions,
    include, exclude,
    gaps: signal.unresolved.filter((u) => u.kind !== "builtin").map((u) => u.name),
    confidence: include.length ? "medium" : "low",
  };
}

/** Map a validated recommendation to a project-namespaced GemSelection. */
export function recommendationToSelection(rec: GemRecommendation): GemSelection {
  const ps: ProjectSelection = {};
  const skills = rec.include.filter((i) => i.type === "skill").map((i) => i.name);
  const mcpServers = rec.include.filter((i) => i.type === "mcp_server").map((i) => i.name);
  const hooks = rec.include.filter((i) => i.type === "hook").map((i) => i.name);
  if (skills.length) ps.skills = skills;
  if (mcpServers.length) ps.mcpServers = mcpServers;
  if (hooks.length) ps.hooks = hooks;
  if (rec.includeInstructions) ps.includeInstructions = true;
  return { projects: { [rec.root]: ps } };
}

/**
 * Validate a raw agent response against the inventory. Any include[].name not
 * present in the inventory is dropped (logged). On any structural failure, fall
 * back to the deterministic recommendation. The inventory is authoritative.
 */
export function validateRecommendation(raw: unknown, inventory: ProjectInventory, signal: WorkflowSignal): GemRecommendation {
  const fallback = deterministicRecommendation(signal);
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return fallback; } }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.include)) return fallback;

  const known = {
    skill: new Set(inventory.skills.map((s) => s.name)),
    mcp_server: new Set(inventory.mcpServers.map((m) => m.name)),
    hook: new Set(inventory.hooks.map((h) => h.name)),
  } as Record<string, Set<string>>;

  const include: RecommendedItem[] = [];
  for (const it of obj.include) {
    if (!it || !SELECTABLE.includes(it.type) || typeof it.name !== "string") continue;
    if (!known[it.type]?.has(it.name)) { console.error(`workflow: dropping hallucinated ${it.type} '${it.name}'`); continue; }
    include.push({ type: it.type, name: it.name, reason: typeof it.reason === "string" ? it.reason : "" });
  }
  if (!include.length) return fallback;   // agent gave nothing usable

  return {
    name: typeof obj.name === "string" ? obj.name : fallback.name,
    description: typeof obj.description === "string" ? obj.description : fallback.description,
    root: signal.root,
    includeInstructions: obj.includeInstructions === true || fallback.includeInstructions,
    include,
    exclude: fallback.exclude.filter((e) => !include.some((i) => i.name === e.name)),
    gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((g: unknown) => typeof g === "string") : fallback.gaps,
    confidence: ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : "medium",
  };
}

// Pull the first {...} block out of an agent message that may wrap JSON in prose/fences.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- acpRecommender`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/acpRecommender.ts src/gem/__tests__/acpRecommender.test.ts
git commit -m "feat(workflow): recommendation types, selection mapping, validation + fallback"
```

---

### Task 5: ACP session + `recommendWorkflow` with connectFn seam and fallback

**Files:**
- Modify: `src/gem/acpRecommender.ts`
- Modify: `package.json` (add dependency)
- Test: `src/gem/__tests__/acpRecommender.test.ts`

**Interfaces:**
- Produces:
  - `interface AgentDescriptor { id: string; name: string; command: string[] }`
  - `type AcpConnectFn = (descriptor: AgentDescriptor, app: unknown) => Promise<{ ctx: AcpCtx; close: () => void }>`
  - `interface AcpCtx { open(cwd: string): Promise<AcpSessionHandle> }` and `interface AcpSessionHandle { setMode(mode: string): Promise<void>; promptText(text: string): Promise<string>; dispose(): void }` (a thin façade over the SDK so tests inject a plain object)
  - `function setConnectFnForTests(fn: AcpConnectFn | null): void`
  - `async function recommendWorkflow(signal: WorkflowSignal, inventory: ProjectInventory, opts?: { connectFn?: AcpConnectFn; timeoutMs?: number }): Promise<{ recommendation: GemRecommendation; degraded: boolean }>`

**Design note:** wrap the raw `@agentclientprotocol/sdk` behind the small `AcpCtx`/`AcpSessionHandle` façade so the test fake is a trivial object and the SDK details live in one `defaultConnectFn`. `recommendWorkflow` is total — it never throws; any failure → `{ recommendation: deterministicRecommendation(signal), degraded: true }`.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd /Users/rfeng/Projects/ninemind/agentgem-workflow-reco
pnpm add @agentclientprotocol/sdk@^0.28
```
Expected: `package.json` gains `"@agentclientprotocol/sdk": "^0.28..."` under dependencies; lockfile updates.

- [ ] **Step 2: Write the failing test** (append)

```ts
import { recommendWorkflow, setConnectFnForTests } from "../acpRecommender.js";

function fakeConnect(canned: string | (() => Promise<string>)) {
  return async () => ({
    ctx: {
      async open(_cwd: string) {
        let mode = "default";
        return {
          async setMode(m: string) { mode = m; },
          async promptText(_t: string) {
            // assert plan mode was enforced before the prompt
            if (mode !== "plan") throw new Error(`expected plan mode, got ${mode}`);
            return typeof canned === "function" ? canned() : canned;
          },
          dispose() {},
        };
      },
    },
    close() {},
  });
}

describe("recommendWorkflow", () => {
  it("parses the agent's JSON, validating against the inventory", async () => {
    const canned = JSON.stringify({ name: "QA Kit", description: "qa flow", include: [{ type: "skill", name: "qa", reason: "core" }], confidence: "high" });
    const { recommendation, degraded } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(recommendation.name).toBe("QA Kit");
    expect(recommendation.include.map((i) => i.name)).toEqual(["qa"]);
  });

  it("drops hallucinated names even from a live agent response", async () => {
    const canned = JSON.stringify({ name: "X", description: "d", include: [{ type: "skill", name: "ghost", reason: "nope" }], confidence: "high" });
    const { recommendation } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(canned) });
    expect(recommendation.include.find((i) => i.name === "ghost")).toBeUndefined();
  });

  it("degrades to the deterministic recommendation on agent error", async () => {
    const { recommendation, degraded } = await recommendWorkflow(signal, inventory, {
      connectFn: async () => { throw new Error("no binary"); },
    });
    expect(degraded).toBe(true);
    expect(recommendation.include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
  });

  it("degrades on timeout", async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r("{}"), 50));
    const { degraded } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(slow), timeoutMs: 5 });
    expect(degraded).toBe(true);
  });
});
```

- [ ] **Step 3: Write minimal implementation** (append to `acpRecommender.ts`)

```ts
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

export interface AgentDescriptor { id: string; name: string; command: string[] }
export interface AcpSessionHandle {
  setMode(mode: string): Promise<void>;
  promptText(text: string): Promise<string>;
  dispose(): void;
}
export interface AcpCtx { open(cwd: string): Promise<AcpSessionHandle> }
export type AcpConnectFn = (descriptor: AgentDescriptor, app: unknown) => Promise<{ ctx: AcpCtx; close: () => void }>;

// Pinned Claude ACP adapter (npm: @agentclientprotocol/claude-agent-acp).
export const CLAUDE_AGENT: AgentDescriptor = { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] };

let testConnectFn: AcpConnectFn | null = null;
export function setConnectFnForTests(fn: AcpConnectFn | null): void { testConnectFn = fn; }

const GROUNDING = (signalJson: string, inventoryJson: string) =>
  `You recommend which installed artifacts to bundle into a reusable "Gem".\n` +
  `USAGE SIGNAL (authoritative — invocation counts are facts):\n${signalJson}\n\n` +
  `INVENTORY (the only artifacts that exist — never invent names outside this):\n${inventoryJson}\n\n` +
  `Return ONLY a JSON object: {"name","description","includeInstructions":bool,` +
  `"include":[{"type":"skill"|"mcp_server"|"hook","name","reason"}],"gaps":[string],"confidence":"high"|"medium"|"low"}.\n` +
  `Cluster the high-usage artifacts into one coherent Gem. Use exact inventory names.`;

export async function recommendWorkflow(
  signal: WorkflowSignal,
  inventory: ProjectInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number } = {},
): Promise<{ recommendation: GemRecommendation; degraded: boolean }> {
  const connectFn = opts.connectFn ?? testConnectFn ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const trimmedInv = trimInventory(inventory);
    conn = await connectFn(CLAUDE_AGENT, null);
    handle = await conn.ctx.open(signal.root);
    await handle.setMode("plan");                 // explicit — never edits files
    const prompt = GROUNDING(JSON.stringify(signal), JSON.stringify(trimmedInv));
    const text = await withTimeout(handle.promptText(prompt), timeoutMs);
    const recommendation = validateRecommendation(text, inventory, signal);
    return { recommendation, degraded: false };
  } catch (err) {
    console.error("workflow: recommender fell back to deterministic:", (err as Error).message);
    return { recommendation: deterministicRecommendation(signal), degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

// Skill bodies are large; send descriptions only to stay within context.
function trimInventory(inv: ProjectInventory) {
  return {
    root: inv.root, name: inv.name,
    skills: inv.skills.map((s) => ({ name: s.name, description: s.description ?? "" })),
    mcpServers: inv.mcpServers.map((m) => ({ name: m.name, transport: m.transport })),
    instructions: inv.instructions.map((i) => ({ name: i.name })),
    hooks: inv.hooks.map((h) => ({ name: h.name, event: h.event, matcher: h.matcher ?? null })),
  };
}

/**
 * Real connect: spawn the ACP adapter and bridge stdio via the SDK. Wrapped so
 * the rest of the module is SDK-agnostic. (Mirrors agentback console-chat's
 * defaultConnectFn, minus the workspace PATH walk and permission routing — this
 * agent runs in plan mode and we auto-deny any permission request.)
 */
export const defaultConnectFn: AcpConnectFn = async (descriptor) => {
  const { client, ndJsonStream } = await import("@agentclientprotocol/sdk");
  const [bin, ...args] = descriptor.command;
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (e) => reject(new Error(`failed to spawn ${bin}: ${e.message}`)));
  });
  const app = client({ name: "agentgem-workflow-recommender" });
  // Auto-deny any permission request — the recommender must not run tools.
  (app as any).onRequest?.("session/request_permission", async () => ({ outcome: { outcome: "cancelled" } }));
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const connection = (app as any).connect(ndJsonStream(output, input));
  const agentCtx = connection.agent;

  const ctx: AcpCtx = {
    async open(cwd: string) {
      const session = await agentCtx.buildSession(cwd).start();
      const sessionId = session.sessionId as string;
      return {
        async setMode(mode: string) { try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ } },
        async promptText(text: string) {
          let out = "";
          void session.prompt(text);
          for (;;) {
            const msg = await session.nextUpdate();
            if (msg.kind === "stop") break;
            if (msg.kind === "session_update" && (msg.update as any).sessionUpdate === "agent_message_chunk") {
              const block = (msg.update as any).content;
              if (block?.type === "text" && typeof block.text === "string") out += block.text;
            }
          }
          return out;
        },
        dispose() { try { session.dispose(); } catch { /* ignore */ } },
      };
    },
  };
  return { ctx, close: () => { try { connection.close(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } } };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- acpRecommender`
Expected: PASS (all tests, including the plan-mode assertion inside the fake).

- [ ] **Step 5: Commit**

```bash
git add src/gem/acpRecommender.ts src/gem/__tests__/acpRecommender.test.ts package.json pnpm-lock.yaml
git commit -m "feat(workflow): ACP recommender session with connectFn seam + fallback"
```

---

### Task 6: `POST /api/workflow/analyze` endpoint + schemas

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/gem.controller.ts`
- Test: `src/gem/__tests__/workflowAnalyze.test.ts` (new)

**Interfaces:**
- Consumes: `introspectAll` (module-private in `gem.controller.ts` — reuse it), `scanWorkflow`, `claudeTranscriptsForCwd`, `recommendWorkflow`, `recommendationToSelection`, `setConnectFnForTests`.
- Produces: route `POST /api/workflow/analyze` with `WorkflowAnalyzeRequestSchema` / `WorkflowAnalyzeResponseSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/workflowAnalyze.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";
import { setConnectFnForTests } from "../acpRecommender.js";

// Minimal .claude home with a skill + a transcript that uses it, all under one cwd.
let home: string, projectRoot: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "wfctl-"));
  const claudeDir = join(home, ".claude");
  projectRoot = join(home, "proj");
  // a project skill so the inventory has something to recommend
  const skillDir = join(projectRoot, ".claude", "skills", "qa");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: qa\ndescription: qa\n---\nbody");
  // a transcript whose cwd is projectRoot and which invokes Skill(qa)
  const folder = join(claudeDir, "projects", "enc");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "s.jsonl"), [
    JSON.stringify({ cwd: projectRoot }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "qa" } }] } }),
  ].join("\n") + "\n");

  setConnectFnForTests(async () => ({
    ctx: { async open() { return { async setMode() {}, async promptText() { return JSON.stringify({ name: "QA", description: "d", include: [{ type: "skill", name: "qa", reason: "used" }], confidence: "high" }); }, dispose() {} }; } },
    close() {},
  }));
});
afterAll(() => { setConnectFnForTests(null); rmSync(home, { recursive: true, force: true }); });

describe("POST /api/workflow/analyze", () => {
  it("returns a recommendation and a project-namespaced pre-checked selection", async () => {
    const ctl = new GemController();
    const res = await ctl.workflowAnalyze({ body: { dir: join(home, ".claude"), root: projectRoot } });
    expect(res.degraded).toBe(false);
    expect(res.recommendation.include.map((i) => i.name)).toContain("qa");
    expect((res.selection as any).projects[projectRoot].skills).toContain("qa");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- workflowAnalyze`
Expected: FAIL — `ctl.workflowAnalyze` is not a function / schemas missing.

- [ ] **Step 3: Add the schemas** (append to `src/schemas.ts`)

```ts
export const WorkflowAnalyzeRequestSchema = z.object({
  dir: z.string().optional(),       // .claude dir (as elsewhere); resolveDirs handles default
  root: z.string(),                 // the project root to analyze (one of the discovered cwds)
});

const RecommendedItemSchema = z.object({
  type: z.enum(["skill", "mcp_server", "instructions", "hook"]),
  name: z.string(),
  reason: z.string(),
});
const GemRecommendationSchema = z.object({
  name: z.string(),
  description: z.string(),
  root: z.string(),
  includeInstructions: z.boolean(),
  include: z.array(RecommendedItemSchema),
  exclude: z.array(RecommendedItemSchema),
  gaps: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
});
export const WorkflowAnalyzeResponseSchema = z.object({
  recommendation: GemRecommendationSchema,
  selection: z.record(z.string(), z.unknown()),   // a GemSelection (validated structurally by buildGem at /api/gem)
  signalSummary: z.object({
    sessionsScanned: z.number(),
    spanDays: z.number(),
    notes: z.array(z.string()),
    gaps: z.array(z.string()),
  }),
  degraded: z.boolean(),
});
```

- [ ] **Step 4: Add the controller method**

Add imports near the other `./gem/*` imports in `src/gem.controller.ts`:

```ts
import { claudeTranscriptsForCwd, scanWorkflow } from "./gem/workflowScan.js";
import { recommendWorkflow, recommendationToSelection } from "./gem/acpRecommender.js";
import { WorkflowAnalyzeRequestSchema, WorkflowAnalyzeResponseSchema } from "./schemas.js";
```

Add the method inside `class GemController`:

```ts
  @post("/workflow/analyze", { body: WorkflowAnalyzeRequestSchema, response: WorkflowAnalyzeResponseSchema })
  async workflowAnalyze(input: { body: z.infer<typeof WorkflowAnalyzeRequestSchema> }): Promise<z.infer<typeof WorkflowAnalyzeResponseSchema>> {
    const { dir, root } = input.body;
    // Inventory for exactly this one project (project-namespaced selection target).
    const inventory = introspectAll(dir, [root]);
    const project = (inventory.projects ?? []).find((p) => p.root === root);
    if (!project) throw new Error(`Project '${root}' not found in inventory`);

    const dirs = resolveDirs(dir);
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
    const signal = scanWorkflow(paths, project);
    const { recommendation, degraded } = await recommendWorkflow(signal, project);
    const selection = recommendationToSelection(recommendation);
    return {
      recommendation,
      selection: selection as Record<string, unknown>,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes, gaps: recommendation.gaps },
      degraded,
    };
  }
```

(`introspectAll`, `resolveDirs` are already in scope in this file.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- workflowAnalyze`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS (all prior tests + the 3 new files).

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/gem/__tests__/workflowAnalyze.test.ts
git commit -m "feat(workflow): POST /api/workflow/analyze endpoint + schemas"
```

---

### Task 7: UI — "Analyze workflow" button that pre-checks the recommendation

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: `POST /api/workflow/analyze` (Task 6); the existing inventory render (`renderCandidate` ~line 341, the project-artifact rows ~lines 440-485 with `data-kind`/`data-name`/`data-project` attributes) and the existing per-checkbox `onToggle` flow.

**Approach:** On a discovered/recent project row, add an "Analyze" button. Clicking it (a) scaffolds/loads that project as the active testbed exactly as "Use this folder" does so the inventory renders, then (b) POSTs to `/api/workflow/analyze`, (c) checks the matching inventory checkboxes from `selection.projects[root]`, and (d) shows the recommendation name/description + per-item reasons in a banner.

- [ ] **Step 1: Locate the exact project-row checkbox attributes**

Read `src/public/index.html` lines 440-485. Confirm the `data-kind` values used for project artifacts (e.g. `projectSkill`, `projectMcp`, `projectHook`, `projectInstructions`) and that each project row carries `data-project="<root>"` and `data-name="<name>"`. Record the exact strings — the apply helper in Step 3 must match them.

- [ ] **Step 2: Add the "Analyze" button to the project row**

In `renderCandidate(path, flavor, name)` (~line 341) and/or the Discovered/Recent row template, add a button next to the existing "Use this" affordance:

```html
<button type="button" class="ghost analyzeBtn" data-path="${esc(path)}" title="recommend a Gem from this project's session history">Analyze</button>
```

- [ ] **Step 3: Wire the handler**

Add a click handler (near the other delegated listeners that handle candidate rows). Use the EXACT `data-kind` strings confirmed in Step 1 (the example below assumes `projectSkill`/`projectMcp`/`projectHook`/`projectInstructions`):

```js
async function analyzeWorkflow(path) {
  // Make this project the active inventory (same path as choosing the folder),
  // so the checkboxes to pre-check are on screen. Reuse the existing scaffold/use flow:
  await useFolder(path);                 // existing fn that scaffolds + renders inventory for `path`

  const banner = document.getElementById("analyzeBanner") || (() => {
    const d = document.createElement("div"); d.id = "analyzeBanner"; d.className = "src";
    document.getElementById("inventory").prepend(d); return d;
  })();
  banner.textContent = "Analyzing session history…";

  let res;
  try {
    res = await (await fetch("/api/workflow/analyze", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: path }),
    })).json();
  } catch (e) { banner.textContent = "Analysis failed: " + e.message; return; }

  const ps = (res.selection.projects || {})[path] || {};
  const check = (kind, names) => (names || []).forEach((n) => {
    const cb = document.querySelector(`#inventory input[data-kind="${kind}"][data-name="${cssEsc(n)}"][data-project="${cssEsc(path)}"]`);
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  check("projectSkill", ps.skills);
  check("projectMcp", ps.mcpServers);
  check("projectHook", ps.hooks);
  if (ps.includeInstructions) {
    const cb = document.querySelector(`#inventory input[data-kind="projectInstructions"][data-project="${cssEsc(path)}"]`);
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  }

  const reasons = res.recommendation.include.map((i) => `${i.name}: ${i.reason}`).join(" · ");
  const degraded = res.degraded ? " (from usage frequency — agent unavailable)" : "";
  const gaps = res.signalSummary.gaps.length ? ` — not in inventory: ${res.signalSummary.gaps.join(", ")}` : "";
  banner.innerHTML = `<strong>${escHtml(res.recommendation.name)}</strong>${degraded}: ${escHtml(res.recommendation.description)}<br>${escHtml(reasons)}${escHtml(gaps)}`;
}

// CSS.escape fallback for attribute selectors
function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
function escHtml(s) { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".analyzeBtn");
  if (btn) { e.preventDefault(); analyzeWorkflow(btn.dataset.path); }
});
```

If `useFolder(path)` is not the exact existing function name, use whatever the "Use this folder" button calls (confirm by reading the handler near `renderCandidate`). The rest of the helper is independent of that name.

- [ ] **Step 4: Manual verification**

Run:
```bash
cd /Users/rfeng/Projects/ninemind/agentgem-workflow-reco
pnpm run dev
```
Then open the app, pick a project with real Claude session history under it, click **Analyze**, and confirm: a banner shows a recommended name/description; the recommended skills/MCP/hook checkboxes under that project become checked; the normal "Build Gem" flow then works on the pre-checked selection.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(workflow): Analyze button pre-checks the recommended selection"
```

---

## Self-Review

**Spec coverage:**
- Deterministic scan → `WorkflowSignal` (Tasks 1-3). ✓ availability-vs-usage guard (Task 2 test), name normalization (Task 2), hooks low-confidence + instructions presence + co-occurrence (Task 3), empty/malformed (Tasks 1,3).
- cwd→transcripts resolver R5 (Task 1). ✓
- ACP recommender, plan mode + empty mcp R6, connectFn seam, timeout, fallback (Task 5). ✓ hallucination guard (Task 4 + Task 5 tests). ✓
- Project-namespaced selection R1, instructions-as-boolean, hook mangled names (Task 4). ✓
- Single JSON endpoint R3 (Task 6), no SSE. ✓
- Claude-only R4 (`flavor:"claude"` hardcoded in scanWorkflow; codex not wired). ✓
- UI pre-checked selection + rationale (Task 7). ✓
- New dep `@agentclientprotocol/sdk@^0.28` (Task 5). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 7 Steps 1/3 explicitly require confirming two existing names (`data-kind` strings, `useFolder`) by reading the file — that is verification of existing code, not a placeholder for new code.

**Type consistency:** `WorkflowSignal`/`ArtifactUsage` (Task 1) used unchanged in Tasks 2-6. `GemRecommendation`/`RecommendedItem` (Task 4) consumed by Tasks 5-6. `recommendationToSelection`/`recommendWorkflow`/`setConnectFnForTests` signatures match across Tasks 4-6. `AcpConnectFn`/`AcpCtx`/`AcpSessionHandle` façade defined in Task 5 and used by the fakes in Tasks 5-6.

**Known integration risk:** Task 7's `useFolder`/`data-kind` names are the only unverified-by-grep identifiers; Step 1 forces confirmation before coding. The live ACP adapter (`claude-agent-acp`) is only exercised in manual Step 4 — all automated tests use the `connectFn` fake, so CI needs no binary.
