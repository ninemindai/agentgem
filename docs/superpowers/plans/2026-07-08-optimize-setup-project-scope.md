# Optimize + Setup Project-Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Global | Project ▾` scope switch to the Optimize and Setup tabs so each can show — and Optimize can act on — a specific project's *effective* config (global ⊕ project, layer-tagged), not just the global layer.

**Architecture:** In project scope the server merges `introspectConfig()` (global) with `introspectProject(root)` (project), tags every row with `layer: "global" | "project"`, and scopes usage to that project's transcripts. The safety invariant — a project view can only prune the project's own layer — is enforced server-side (`prune`/eligibility gated by owned layer) and in the UI (Disable only offered on owned-layer rows). Disable targets the project's config files via the existing `DisableOptions`.

**Tech Stack:** TypeScript (ESM), Zod schemas (agentback `defineRoute`), React (console SPA), Vitest. Monorepo: `packages/insight`, `packages/capture`, `packages/console`, root `src/`.

## Global Constraints

- Node floor `>=24`.
- Per-package test commands (each package has its own vitest config):
  - **insight**: `pnpm -C packages/insight test` (globs `src/**/*.test.ts`, node env — no dist build needed; type-level RED via `pnpm -C packages/insight exec tsc -b`).
  - **console**: `pnpm -C packages/console test` or `pnpm -C packages/console exec vitest run <src-path>` (jsdom, globs `src/**/*.test.{ts,tsx}`); typecheck via `pnpm -C packages/console run typecheck` (NOT `tsc -b`).
  - **root/server**: `pnpm build` then `npx vitest run dist/__tests__/<file>.test.js` (root config globs `dist/**/__tests__/**/*.test.js`).
- `workflowScan.ts` is binary-classified by git/grep — use `grep -a` if searching it.
- Client (`packages/console/src/api/routes.ts`) and server (`src/gem.controller.ts`) Zod schemas are **separate mirrors** and MUST stay in sync — a client POST body field missing on the server 422s silently.
- Console tests + typecheck are NOT in CI — run them locally.
- All new query/body fields are **optional** (backward-compatible: absent = today's global behavior).
- Commit after every task.

---

## File map

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/insight/src/optimizeAnalyze.ts` | pure payload builder | add `layer` to `OptimizeArtifact`, derive it; root-aware `changeHint` |
| `packages/insight/src/optimizeScan.ts` | usage-scan IO seam | add project-cwd-scoped usage scan |
| `src/gem.controller.ts` | `/optimize`, `/optimize/disable`, `/optimize/enable`, `/inventory` handlers + server Zod schemas | branch on `root`; merge + project usage + scoped disabled; `DisableOptions` targeting project; owned-layer guard; `layer` in schema |
| `packages/console/src/api/routes.ts` | client route contracts (mirror) | `layer` on `OptimizeArtifactSchema`; `root` on optimize/disable/enable; `projects` on `inventoryRoute`; type `InventorySchema.projects` |
| `packages/console/src/panels/_shared/ScopePicker.tsx` | shared Global/Project selector | **create** |
| `packages/console/src/panels/Optimize/index.tsx` | Optimize container | scope state → `root` in fetch + disable/enable |
| `packages/console/src/panels/Optimize/Dashboard.tsx` | Optimize view | scope-aware `eligible()`, `layer` badge, advisory rows |
| `packages/console/src/panels/Setup/index.tsx` | Setup browser | scope state → `projects` in fetch; render project artifacts with `layer` badge |

---

## Task 1: `layer` field on OptimizeArtifact (insight, pure)

**Files:**
- Modify: `packages/insight/src/optimizeAnalyze.ts`
- Test: `packages/insight/src/__tests__/optimizeAnalyze.test.ts` (create if absent; else add cases)

**Interfaces:**
- Produces: `OptimizeArtifact` gains `layer: "global" | "project"`. `changeHint(type, name, source, root?)` — when `root` is given and `source === "project"`, `file` paths use `<root>/.claude|.agents|...` instead of `~/...`.

- [ ] **Step 1: Write the failing test**

Create/append `packages/insight/src/__tests__/optimizeAnalyze.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildOptimizePayload } from "../optimizeAnalyze.js";
import type { ConfigInventory } from "@agentgem/model";
import type { ArtifactUsage } from "../workflowScan.js";

const inv = (): ConfigInventory => ({
  skills: [
    { type: "skill", name: "g-skill", source: "user", description: "d" } as any,
    { type: "skill", name: "p-skill", source: "project", description: "d" } as any,
  ],
  mcpServers: [], instructions: [], hooks: [], subagents: [],
});

describe("buildOptimizePayload layer", () => {
  it("tags global-source rows layer:global and project-source rows layer:project", () => {
    const usage = new Map<string, ArtifactUsage>();
    const p = buildOptimizePayload(inv(), usage, "all", 1_000_000_000);
    const g = p.artifacts.find((a) => a.name === "g-skill")!;
    const pr = p.artifacts.find((a) => a.name === "p-skill")!;
    expect(g.layer).toBe("global");
    expect(pr.layer).toBe("project");
  });

  it("points a project row's change.file at the project root when root is passed", () => {
    const usage = new Map<string, ArtifactUsage>();
    const p = buildOptimizePayload(inv(), usage, "all", 1_000_000_000, "/repo/x");
    const pr = p.artifacts.find((a) => a.name === "p-skill")!;
    expect(pr.change.file).toBe("/repo/x/.claude/skills/p-skill");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/insight build && npx vitest run packages/insight/dist/__tests__/optimizeAnalyze.test.js -t "layer"`
Expected: FAIL — `layer` is `undefined`; `buildOptimizePayload` takes 4 args.

- [ ] **Step 3: Implement**

In `optimizeAnalyze.ts`:

Add `layer` to the interface:
```ts
export interface OptimizeArtifact {
  name: string;
  type: "skill" | "mcp";
  source: string;
  layer: "global" | "project";    // which config surface it lives on
  contextTokens: number;
  uses: number;
  lastUsedMs: number | null;
  prune: boolean;
  change: { file: string; key: string };
}
```

Make `changeHint` root-aware:
```ts
function changeHint(type: "skill" | "mcp", name: string, source: string, root?: string): { file: string; key: string } {
  const plugin = pluginKey(source);
  if (plugin) return { file: "settings.json", key: `enabledPlugins["${plugin}"] = false` };
  const base = source === "project" && root ? root : "~";
  if (type === "skill") {
    const rel =
      source === "agent" ? ".agents/skills" :
      source === "codex" ? ".codex/skills" :
      source === "hermes" ? ".hermes/skills" :
      source === "project" ? ".claude/skills" :
      ".claude/skills";
    return { file: `${base}/${rel}/${name}`, key: "remove or move this folder (no in-place disable flag exists)" };
  }
  if (source === "codex") return { file: `${base}/.codex/config.toml`, key: `set enabled = false for ${name}` };
  if (source === "project") return { file: `${base}/.claude/settings.json`, key: `remove mcpServers.${name}` };
  return { file: "settings.json / ~/.claude.json", key: `remove mcpServers.${name} (or add "${name}" to disabledMcpjsonServers if defined via .mcp.json)` };
}
```

In `buildArtifacts`, thread `root` and set `layer` (add `root?: string` param):
```ts
function buildArtifacts(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number, root?: string): OptimizeArtifact[] {
  const cutoff = rangeStartMs(range, nowMs);
  const out: OptimizeArtifact[] = [];

  const push = (type: "skill" | "mcp", name: string, source: string, contextTokens: number, key: string) => {
    const u = usage.get(key);
    const uses = u?.invocations ?? 0;
    const lastUsedMs = u?.lastUsedMs ?? null;
    const prune = lastUsedMs === null || lastUsedMs < cutoff;
    const layer: "global" | "project" = source === "project" ? "project" : "global";
    out.push({ name, type, source, layer, contextTokens, uses, lastUsedMs, prune, change: changeHint(type, name, source, root) });
  };
  // ...rest unchanged...
```

Thread `root` through `buildOptimizePayload`:
```ts
export function buildOptimizePayload(inv: ConfigInventory, usage: Map<string, ArtifactUsage>, range: OptimizeRange, nowMs: number, root?: string): OptimizePayload {
  return {
    range,
    artifacts: buildArtifacts(inv, usage, range, nowMs, root),
    instructions: buildInstructions(inv),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/insight build && npx vitest run packages/insight/dist/__tests__/optimizeAnalyze.test.js -t "layer"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/optimizeAnalyze.ts packages/insight/src/__tests__/optimizeAnalyze.test.ts
git commit -m "feat(insight): tag optimize artifacts with global/project layer + root-aware change hint"
```

---

## Task 2: Project-cwd-scoped usage scan (insight, IO seam)

**Files:**
- Modify: `packages/insight/src/optimizeScan.ts`
- Test: `packages/insight/src/__tests__/optimizeScan.test.ts` (create/append)

**Interfaces:**
- Produces: `scanArtifactUsage(inv, claudeDir, cwd?)` — when `cwd` is passed, scans only transcripts whose session cwd === `cwd` (via `claudeTranscriptsForCwd`); else all transcripts (unchanged). `scanArtifactUsageCached(inv, nowMs, claudeDir?, refresh?, cwd?)` — `cwd` present bypasses the cache (like `claudeDir`).

- [ ] **Step 1: Write the failing test**

Create/append `packages/insight/src/__tests__/optimizeScan.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactUsage } from "../optimizeScan.js";
import type { ConfigInventory } from "@agentgem/model";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "optscan-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Minimal transcript: two sessions in different cwds, each invoking a skill.
function writeSession(folder: string, cwd: string, skill: string) {
  const d = join(dir, "projects", folder);
  mkdirSync(d, { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", cwd }),
    JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "tool_use", name: "Skill", input: { command: skill } }] } }),
  ].join("\n");
  writeFileSync(join(d, "s.jsonl"), lines + "\n");
}

const inv: ConfigInventory = {
  skills: [{ type: "skill", name: "alpha", source: "project", description: "" } as any],
  mcpServers: [], instructions: [], hooks: [], subagents: [],
};

describe("scanArtifactUsage cwd filter", () => {
  it("counts only the chosen project's sessions when cwd is passed", () => {
    writeSession("a", "/repo/a", "alpha");
    writeSession("b", "/repo/b", "alpha");
    const all = scanArtifactUsage(inv, dir);
    const scoped = scanArtifactUsage(inv, dir, "/repo/a");
    expect(all.get("skill:alpha")?.invocations).toBe(2);
    expect(scoped.get("skill:alpha")?.invocations).toBe(1);
  });
});
```

> Note: if the transcript shape above doesn't match `scanWorkflow`'s parser, read one real transcript under `~/.claude/projects/*/` and mirror the exact `tool_use`/`Skill(...)` shape `scanWorkflow` detects. The assertion (all=2, scoped=1) is the invariant that matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/insight test`
Expected: FAIL — `scanArtifactUsage` ignores the 3rd arg (both counts equal, so `scoped` is 2 not 1).

- [ ] **Step 3: Implement**

In `optimizeScan.ts`, import the cwd helper and thread `cwd`:
```ts
import { scanWorkflow, allClaudeTranscripts, claudeTranscriptsForCwd, type ArtifactUsage } from "./workflowScan.js";

export function scanArtifactUsage(inv: ConfigInventory, claudeDir: string, cwd?: string): Map<string, ArtifactUsage> {
  const paths = cwd ? claudeTranscriptsForCwd(claudeDir, cwd) : allClaudeTranscripts(claudeDir);
  const signal = scanWorkflow(paths, { project: syntheticProject(inv), global: { skills: [], mcpServers: [], hooks: [] } });
  const map = new Map<string, ArtifactUsage>();
  for (const a of signal.artifacts) {
    if (a.type === "skill" || a.type === "mcp_server") map.set(`${a.type}:${a.name}`, a);
  }
  return map;
}

export async function scanArtifactUsageCached(inv: ConfigInventory, nowMs: number, claudeDir?: string, refresh = false, cwd?: string): Promise<Map<string, ArtifactUsage>> {
  if (cwd) return scanArtifactUsage(inv, claudeDir ?? join(homedir(), ".claude"), cwd);   // project scope bypasses cache
  if (claudeDir) return scanArtifactUsage(inv, claudeDir);
  const dir = join(homedir(), ".claude");
  if (!refresh && cache && nowMs - cache.atMs < SCAN_TTL_MS) return cache.map;
  const map = scanArtifactUsage(inv, dir);
  cache = { atMs: nowMs, map };
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/insight test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/optimizeScan.ts packages/insight/src/__tests__/optimizeScan.test.ts
git commit -m "feat(insight): project-cwd-scoped artifact usage scan"
```

---

## Task 3: Server — `/optimize?root=`, project-targeted disable/enable, layer schema (server)

**Files:**
- Modify: `src/gem.controller.ts` (schemas ~124-166; handlers `optimize` ~613, `optimizeDisable` ~647, `optimizeEnable` ~652)
- Test: `src/__tests__/optimizeScope.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `buildOptimizePayload(inv, usage, range, now, root?)`, Task 2 `scanArtifactUsage(inv, claudeDir, cwd?)`; existing `introspectConfig`, `introspectProject`, `resolveProject`, `disableArtifacts`, `enableArtifacts`, `listDisabled` (+`DisableOptions`), `resolveDirs`.
- Produces: `OptimizeQuerySchema` gains `root?: string`; server `OptimizeArtifactSchema` gains `layer`; `DisableBodySchema`/`EnableBodySchema` gain `root?: string`. Helper `projectDisableOpts(root)`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/optimizeScope.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, listDisabled } from "@agentgem/capture";

// Project-targeted disable relocates the skill under <root>/.agentgem/disabled and
// listDisabled scoped to the project reads it back — the mechanism the /optimize
// project scope relies on.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "proj-"));
  const skillDir = join(root, ".claude", "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("project-scoped disable", () => {
  it("archives under the project root and lists it back", () => {
    const opts = { claudeDir: join(root, ".claude"), agentDir: join(root, ".agents"), codexDir: join(root, ".codex"), hermesDir: join(root, ".hermes") };
    const [r] = disableArtifacts([{ type: "skill", name: "demo", source: "project" }], opts);
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".claude", "skills", "demo"))).toBe(false);
    expect(existsSync(join(root, ".agentgem", "disabled"))).toBe(true);
    expect(listDisabled(opts).some((d) => d.name === "demo")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails/passes-baseline**

Run: `pnpm build && npx vitest run dist/__tests__/optimizeScope.test.js`
Expected: PASS already (proves the capture mechanism). If it FAILS, read `packages/capture/src/disableArtifact.ts` `disableSkill` to confirm the `<base>/.agentgem/disabled` path and adjust the assertion — do not change capture.

- [ ] **Step 3: Implement the server wiring**

In `src/gem.controller.ts`:

Extend the query + schemas (near lines 124-166):
```ts
const OptimizeQuerySchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]).optional(),
  refresh: z.coerce.boolean().optional(),
  root: z.string().optional(),        // present => project/effective scope
});
```
Add `layer` to the server `OptimizeArtifactSchema` (line ~139):
```ts
  layer: z.enum(["global", "project"]),
```
Add `root` to disable/enable bodies (lines ~130, ~162):
```ts
const DisableBodySchema = z.object({ artifacts: z.array(DisableItemSchema), root: z.string().optional() });
// EnableBodySchema already .extend(...)s DisableBodySchema, so it inherits root.
```

Add a helper near the other module-level helpers:
```ts
import { join as pathJoin } from "node:path";
function projectDisableOpts(root: string) {
  const p = resolveProject(root);
  return { claudeDir: pathJoin(p, ".claude"), agentDir: pathJoin(p, ".agents"), codexDir: pathJoin(p, ".codex"), hermesDir: pathJoin(p, ".hermes") };
}
function mergedInventory(root: string) {
  const project = introspectProject(resolveProject(root));
  const g = introspectConfig();
  return {
    skills: [...g.skills, ...project.skills],
    mcpServers: [...g.mcpServers, ...project.mcpServers],
    instructions: [...g.instructions, ...project.instructions],
    hooks: [...g.hooks, ...project.hooks],
    subagents: [...g.subagents, ...project.subagents],
  };
}
```

Rewrite the `optimize` handler (line ~613):
```ts
@get("/optimize", { query: OptimizeQuerySchema, response: OptimizePayloadSchema })
async optimize(input: { query: z.infer<typeof OptimizeQuerySchema> }): Promise<z.infer<typeof OptimizePayloadSchema>> {
  const range: OptimizeRange = input.query.range ?? "30d";
  const now = Date.now();
  const refresh = input.query.refresh ?? false;
  const root = input.query.root;
  if (root) {
    const canon = resolveProject(root);
    const inv = mergedInventory(canon);
    const usage = await scanArtifactUsageCached(inv, now, undefined, refresh, canon);   // project-cwd usage
    const payload = buildOptimizePayload(inv, usage, range, now, canon);
    return { ...payload, disabled: listDisabled(projectDisableOpts(canon)) };
  }
  const inv = introspectConfig();
  const usage = await scanArtifactUsageCached(inv, now, undefined, refresh);
  const payload = buildOptimizePayload(inv, usage, range, now);
  return { ...payload, disabled: listDisabled() };
}
```

Update `optimizeDisable` (line ~647) with the owned-layer guard + project opts:
```ts
@post("/optimize/disable", { body: DisableBodySchema, response: DisableResponseSchema })
async optimizeDisable(input: { body: z.infer<typeof DisableBodySchema> }): Promise<z.infer<typeof DisableResponseSchema>> {
  const root = input.body.root;
  // Owned-layer guard: project scope disables only project rows; global scope only global rows.
  const guard = (it: { source: string; type: string; name: string }) =>
    (root ? it.source === "project" : it.source !== "project");
  const [ok, bad] = [input.body.artifacts.filter(guard), input.body.artifacts.filter((it) => !guard(it))];
  const results = [
    ...disableArtifacts(ok, root ? projectDisableOpts(root) : {}),
    ...bad.map((it) => ({ type: it.type, name: it.name, ok: false, message: root ? "global artifact — switch to Global scope to disable" : "project artifact — pick its project to disable" })),
  ];
  return { results };
}
```

Update `optimizeEnable` (line ~652) similarly — pass project opts to `enableArtifacts`, and rebuild rows from the project scope when `root` is present:
```ts
@post("/optimize/enable", { body: EnableBodySchema, response: EnableResponseSchema })
async optimizeEnable(input: { body: z.infer<typeof EnableBodySchema> }): Promise<z.infer<typeof EnableResponseSchema>> {
  const root = input.body.root;
  const opts = root ? projectDisableOpts(root) : {};
  const results = enableArtifacts(input.body.artifacts, opts);
  const okTypeNames = new Set(results.filter((r) => r.ok).map((r) => `${r.type}:${r.name}`));
  const okKeys = new Set(
    input.body.artifacts.filter((a) => okTypeNames.has(`${a.type}:${a.name}`)).map((a) => `${a.type}:${a.source}:${a.name}`),
  );
  const now = Date.now();
  const range = input.body.range ?? "30d";
  const inv = root ? mergedInventory(resolveProject(root)) : introspectConfig();
  const usage = await scanArtifactUsageCached(inv, now, undefined, false, root ? resolveProject(root) : undefined);
  const payload = buildOptimizePayload(inv, usage, range, now, root ? resolveProject(root) : undefined);
  const artifacts = payload.artifacts.filter((a) => okKeys.has(`${a.type}:${a.source}:${a.name}`));
  return { results, artifacts };
}
```

> If `resolveProject` / `scanArtifactUsageCached` / `buildOptimizePayload` aren't already imported at the top of `gem.controller.ts`, add them (they come from `@agentgem/capture` and `@agentgem/insight`; check the existing import block ~line 213 and the insight import).

- [ ] **Step 4: Add a server route test for the merged payload**

Append to `src/__tests__/optimizeScope.test.ts` a test that calls the controller method directly (pattern: other controller tests in `src/__tests__/` construct `new GemController()` — mirror the nearest existing one):

```ts
import { GemController } from "../gem.controller.js";

describe("GET /optimize?root=", () => {
  it("returns project rows as layer:project and includes global rows as layer:global", async () => {
    const c = new GemController();
    const res = await c.optimize({ query: { range: "all", root } });
    expect(res.artifacts.some((a) => a.name === "demo" && a.layer === "project")).toBe(true);
    expect(res.artifacts.every((a) => a.layer === "global" || a.layer === "project")).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm build && npx vitest run dist/__tests__/optimizeScope.test.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/gem.controller.ts src/__tests__/optimizeScope.test.ts
git commit -m "feat(server): /optimize project scope — merged layered inventory, project usage, project-targeted disable + owned-layer guard"
```

---

## Task 4: Client route contracts — mirror `layer` + `root` (console)

**Files:**
- Modify: `packages/console/src/api/routes.ts`

**Interfaces:**
- Produces: `OptimizeArtifact` type gains `layer`; `optimizeRoute` query gains `root?`; `disableArtifactsRoute`/`enableArtifactsRoute` bodies gain `root?`.

- [ ] **Step 1: Edit the schemas**

`OptimizeArtifactSchema` — add after `source`:
```ts
  layer: z.enum(["global", "project"]),
```
`optimizeRoute` — add `root` to its query:
```ts
export const optimizeRoute = defineRoute("GET", "/api/optimize", {
  query: z.object({ range: z.enum(["today","7d","30d","all"]).optional(), refresh: z.boolean().optional(), root: z.string().optional() }),
  response: OptimizePayloadSchema,
});
```
`disableArtifactsRoute` body (line ~712) and `enableArtifactsRoute` body (line ~719) — add `root: z.string().optional()`:
```ts
  body: z.object({ artifacts: z.array(DisableItemSchema), root: z.string().optional() }),
// enable:
  body: z.object({ artifacts: z.array(DisableItemSchema), range: z.enum(["today","7d","30d","all"]).optional(), root: z.string().optional() }),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -C packages/console run typecheck`
Expected: PASS (Dashboard/Optimize still compile; `layer` is additive).

- [ ] **Step 3: Commit**

```bash
git add packages/console/src/api/routes.ts
git commit -m "feat(console): mirror optimize layer field + root scope on optimize/disable/enable routes"
```

---

## Task 5: Shared `ScopePicker` component (console)

**Files:**
- Create: `packages/console/src/panels/_shared/ScopePicker.tsx`
- Test: `packages/console/src/panels/_shared/ScopePicker.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type Scope = { kind: "global" } | { kind: "project"; root: string; label: string };
  export function ScopePicker(props: { apiBase: string; scope: Scope; onScope: (s: Scope) => void }): JSX.Element;
  ```
  Renders a `Global` button + a `Project ▾` control; when opened, lists recents/candidates from `testbedRecentsRoute` + `testbedProjectsRoute` (deduped by path, ~40 cap) with a search box. Selecting sets `{ kind: "project", root: path, label: basename }`.

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/_shared/ScopePicker.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScopePicker, type Scope } from "./ScopePicker.js";

vi.mock("../../api/routes.js", async (orig) => {
  const m = await (orig as any)();
  return {
    ...m,
    makeClient: () => ({}),
    testbedRecentsRoute: { call: async () => ({ recents: [{ root: "/repo/a", label: "a" }] }) },
    testbedProjectsRoute: { call: async () => ({ projects: [{ path: "/repo/b", flavor: "x", lastUsed: null, exists: true }] }) },
  };
});

describe("ScopePicker", () => {
  it("highlights Global by default and switches to a picked project", async () => {
    let scope: Scope = { kind: "global" };
    const onScope = vi.fn((s: Scope) => { scope = s; });
    render(<ScopePicker apiBase="" scope={scope} onScope={onScope} />);
    fireEvent.click(screen.getByRole("button", { name: /project/i }));
    const opt = await screen.findByText("/repo/a");
    fireEvent.click(opt);
    expect(onScope).toHaveBeenCalledWith({ kind: "project", root: "/repo/a", label: "a" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/_shared/ScopePicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (mirror the Insights/Rubrics picker pattern in `panels/Insights/index.tsx` lines ~62-104 for the recents+candidates+search list)

```tsx
// packages/console/src/panels/_shared/ScopePicker.tsx
import { useEffect, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient } from "../../api/routes.js";

export type Scope = { kind: "global" } | { kind: "project"; root: string; label: string };

function basename(p: string): string { return p.replace(/\/+$/, "").split("/").pop() || p; }

export function ScopePicker({ apiBase, scope, onScope }: { apiBase: string; scope: Scope; onScope: (s: Scope) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ root: string; label: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const client = makeClient(apiBase);
    Promise.all([
      testbedRecentsRoute.call(client, {}).then((r: any) => r.recents.map((x: any) => ({ root: x.root, label: x.label ?? basename(x.root) }))).catch(() => []),
      testbedProjectsRoute.call(client, {}).then((r: any) => r.projects.map((x: any) => ({ root: x.path, label: basename(x.path) }))).catch(() => []),
    ]).then(([recents, projects]) => {
      if (!alive) return;
      const seen = new Set<string>();
      const merged = [...recents, ...projects].filter((r) => (seen.has(r.root) ? false : (seen.add(r.root), true))).slice(0, 40);
      setRows(merged);
    });
    return () => { alive = false; };
  }, [open, apiBase]);

  const filtered = rows.filter((r) => !q || r.root.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="scope-picker">
      <button className={"obs-range-btn" + (scope.kind === "global" ? " is-active" : "")} onClick={() => onScope({ kind: "global" })}>Global</button>
      <button className={"obs-range-btn" + (scope.kind === "project" ? " is-active" : "")} onClick={() => setOpen((o) => !o)}>
        {scope.kind === "project" ? `Project: ${scope.label}` : "Project"} ▾
      </button>
      {open && (
        <div className="scope-menu">
          <input aria-label="search projects" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {filtered.map((r) => (
              <li key={r.root}>
                <button onClick={() => { onScope({ kind: "project", root: r.root, label: r.label }); setOpen(false); }}>{r.root}</button>
              </li>
            ))}
            {filtered.length === 0 && <li className="obs-muted">No projects.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/panels/_shared/ScopePicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/_shared/ScopePicker.tsx packages/console/src/panels/_shared/ScopePicker.test.tsx
git commit -m "feat(console): shared Global/Project ScopePicker"
```

---

## Task 6: Wire scope into Optimize (console)

**Files:**
- Modify: `packages/console/src/panels/Optimize/index.tsx`, `packages/console/src/panels/Optimize/Dashboard.tsx`
- Test: `packages/console/src/panels/Optimize/Dashboard.test.tsx` (append; a DisableActions/Dashboard test file already exists — mirror its harness)

**Interfaces:**
- Consumes: `ScopePicker`, `Scope` (Task 5); `optimizeRoute`/`disableArtifactsRoute`/`enableArtifactsRoute` with `root` (Task 4); `OptimizeArtifact.layer` (Task 4).
- Produces: Dashboard accepts `scope: Scope`; `eligible(a, scope)` gates on owned layer; rows show a `layer` badge; advisory (non-owned-layer) rows show a note and no checkbox.

- [ ] **Step 1: Write the failing Dashboard test**

Append to `packages/console/src/panels/Optimize/Dashboard.test.tsx` (create if absent, mirroring `DisableActions.test.tsx`):
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "./Dashboard.js";

const payload = (layer: "global" | "project") => ({
  range: "all" as const, instructions: [], disabled: [],
  artifacts: [{ name: "demo", type: "skill" as const, source: layer === "project" ? "project" : "user", layer, contextTokens: 10, uses: 0, lastUsedMs: null, prune: true, change: { file: "x", key: "y" } }],
});

describe("Dashboard scope-aware eligibility", () => {
  it("in project scope, a project row is disable-eligible (checkbox present)", () => {
    render(<Dashboard data={payload("project")} range="all" onRange={() => {}} pending={false} apiBase="" scope={{ kind: "project", root: "/r", label: "r" }} onScope={() => {}} />);
    expect(screen.getByLabelText("select demo")).toBeTruthy();
  });
  it("in project scope, a global row is advisory (no checkbox)", () => {
    render(<Dashboard data={payload("global")} range="all" onRange={() => {}} pending={false} apiBase="" scope={{ kind: "project", root: "/r", label: "r" }} onScope={() => {}} />);
    expect(screen.queryByLabelText("select demo")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Optimize/Dashboard.test.tsx`
Expected: FAIL — Dashboard doesn't accept `scope`; `eligible` not scope-aware.

- [ ] **Step 3: Implement — `index.tsx`**

Add scope state, render `ScopePicker`, thread `root` into fetch + pass `scope` to Dashboard:
```tsx
import { ScopePicker, type Scope } from "../_shared/ScopePicker.js";
// ...
const [scope, setScope] = useState<Scope>({ kind: "global" });
const root = scope.kind === "project" ? scope.root : undefined;
// in the effect deps add `root`; in the call:
optimizeRoute.call(makeClient(apiBase), { query: { range, ...(root ? { root } : {}), ...(fresh ? { refresh: true } : {}) } })
// deps: [apiBase, range, reloadKey, root]
// render:
return <Dashboard data={data} range={range} onRange={setRange} pending={pending} onRefresh={onRefresh} onMutate={onMutate} apiBase={apiBase} scope={scope} onScope={setScope} />;
```

- [ ] **Step 4: Implement — `Dashboard.tsx`**

- Add `scope: Scope; onScope: (s: Scope) => void` to props; import `ScopePicker`, `Scope`.
- Replace the eligibility helper:
```ts
const DRAFT = new Set(["distilled-draft"]);
function eligible(a: OptimizeArtifact, scope: Scope): boolean {
  if (!a.prune || DRAFT.has(a.source)) return false;
  return scope.kind === "project" ? a.layer === "project" : a.layer === "global";
}
```
- Everywhere `eligible(a)` is called (the `useSelectableList` `eligible` option and the row `<td>`), pass `scope`: `eligible: (a) => eligible(a, scope)` and `eligible(a, scope)`.
- Thread `root` into the disable/enable calls:
```ts
const root = scope.kind === "project" ? scope.root : undefined;
// disableSelected:
disableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts, ...(root ? { root } : {}) } })
// reEnable:
enableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts: items.map(...), range, ...(root ? { root } : {}) } })
```
- Render `<ScopePicker apiBase={apiBase} scope={scope} onScope={onScope} />` in `.opt-head` (next to the ranges).
- Add a `layer` badge in the artifact row (after the source cell):
```tsx
<td className="obs-muted">{a.source}{a.layer === "global" && scope.kind === "project" ? <span className="opt-flag" title="global — manage in Global scope"> global</span> : null}</td>
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/panels/Optimize/Dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + existing Optimize tests**

Run: `pnpm -C packages/console run typecheck && pnpm -C packages/console exec vitest run src/panels/Optimize`
Expected: PASS (adjust any existing Dashboard/DisableActions test that constructs Dashboard without the new `scope`/`onScope` props — pass `scope={{kind:"global"}} onScope={()=>{}}`).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Optimize
git commit -m "feat(console): Optimize global/project scope switch — owned-layer disable + layer badges"
```

---

## Task 7: Client inventory route — `projects` query + typed projects (console)

**Files:**
- Modify: `packages/console/src/api/routes.ts`

**Interfaces:**
- Produces: `inventoryRoute` gains query `{ dir?: string; projects?: string }`; `InventorySchema.projects` typed as `ProjectInventory[]` (root/name + artifact arrays) instead of `z.unknown()`.

- [ ] **Step 1: Edit**

Add a project-inventory schema near `InventorySchema` and type `projects`:
```ts
export const ProjectInventorySchema = z.object({
  root: z.string(), name: z.string(),
  skills: z.array(ArtifactSchema), mcpServers: z.array(ArtifactSchema),
  instructions: z.array(ArtifactSchema), hooks: z.array(ArtifactSchema), subagents: z.array(ArtifactSchema),
});
export type ProjectInventory = z.infer<typeof ProjectInventorySchema>;
```
In `InventorySchema` replace `projects: z.array(z.unknown()).optional()` with `projects: z.array(ProjectInventorySchema).optional()`.
Give `inventoryRoute` a query:
```ts
export const inventoryRoute = defineRoute("GET", "/api/inventory", {
  query: z.object({ dir: z.string().optional(), projects: z.string().optional() }),
  response: InventorySchema,
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -C packages/console run typecheck`
Expected: PASS (Setup's existing `inventoryRoute.call(..., {})` still valid — query is optional).

- [ ] **Step 3: Commit**

```bash
git add packages/console/src/api/routes.ts
git commit -m "feat(console): inventory route accepts projects query + typed project inventory"
```

---

## Task 8: Wire scope into Setup (console)

**Files:**
- Modify: `packages/console/src/panels/Setup/index.tsx`
- Test: `packages/console/src/panels/Setup/Setup.test.tsx` (create)

**Interfaces:**
- Consumes: `ScopePicker`/`Scope` (Task 5); `inventoryRoute` with `projects` query + typed `projects` (Task 7).
- Produces: Setup shows the `ScopePicker`; in project scope it fetches `{ projects: root }` and renders `inv.projects[0]` artifacts alongside the global ones, each carrying a `layer` badge.

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Setup/Setup.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Setup } from "./index.js";

vi.mock("../../api/routes.js", async (orig) => {
  const m = await (orig as any)();
  const global = { skills: [{ type: "skill", name: "g-skill", source: "user", description: "" }], mcpServers: [], instructions: [], hooks: [], subagents: [] };
  const withProject = { ...global, projects: [{ root: "/repo/a", name: "a", skills: [{ type: "skill", name: "p-skill", source: "project", description: "" }], mcpServers: [], instructions: [], hooks: [], subagents: [] }] };
  return {
    ...m, makeClient: () => ({}),
    inventoryRoute: { call: async (_c: any, req: any) => (req?.query?.projects ? withProject : global) },
    testbedRecentsRoute: { call: async () => ({ recents: [{ root: "/repo/a", label: "a" }] }) },
    testbedProjectsRoute: { call: async () => ({ projects: [] }) },
  };
});

describe("Setup project scope", () => {
  it("shows project artifacts with a layer badge when a project is picked", async () => {
    render(<Setup apiBase="" />);
    await screen.findByText("g-skill");
    fireEvent.click(screen.getByRole("button", { name: /project/i }));
    fireEvent.click(await screen.findByText("/repo/a"));
    expect(await screen.findByText("p-skill")).toBeTruthy();
    expect(screen.getAllByText(/project/i).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Setup/Setup.test.tsx`
Expected: FAIL — no ScopePicker; project artifacts not rendered.

- [ ] **Step 3: Implement**

In `Setup/index.tsx`:
- Import `ScopePicker`, `Scope`; add `const [scope, setScope] = useState<Scope>({ kind: "global" })`.
- In the inventory effect, pass the query and merge project artifacts with a `layer` tag:
```ts
const root = scope.kind === "project" ? scope.root : undefined;
inventoryRoute.call(makeClient(apiBase), { query: root ? { projects: root } : {} })
  .then((res) => {
    if (!root || !res.projects?.length) { setInv(res); return; }
    const proj = res.projects[0];
    // Merge project artifacts into the flat lists so the existing type-tab render shows both;
    // tag project ones so the badge can distinguish them.
    const tag = (arr: any[], layer: string) => arr.map((a) => ({ ...a, _layer: layer }));
    setInv({
      ...res,
      skills: [...tag(res.skills, "global"), ...tag(proj.skills, "project")],
      mcpServers: [...tag(res.mcpServers, "global"), ...tag(proj.mcpServers, "project")],
      instructions: [...tag(res.instructions, "global"), ...tag(proj.instructions, "project")],
      hooks: [...tag(res.hooks, "global"), ...tag(proj.hooks, "project")],
      subagents: [...tag(res.subagents, "global"), ...tag(proj.subagents, "project")],
    } as any);
  })
  .catch((e) => setError(String(e?.message ?? e)));
// effect deps: [apiBase, root]
```
- Render `<ScopePicker apiBase={apiBase} scope={scope} onScope={setScope} />` in the Setup header (next to the type tabs).
- In the artifact row/card render, show a badge when `(a as any)._layer === "project"`:
```tsx
{(a as any)._layer === "project" && <span className="opt-flag" title="project-local">project</span>}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/panels/Setup/Setup.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + Setup suite**

Run: `pnpm -C packages/console run typecheck && pnpm -C packages/console exec vitest run src/panels/Setup`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Setup
git commit -m "feat(console): Setup global/project scope switch with layer badges"
```

---

## Final verification

- [ ] **Full build + typecheck:** `pnpm build` — expect `tsc -b` clean + console SPA written.
- [ ] **Full suite:** `npx vitest run` (root) — expect green, no regressions.
- [ ] **Console suite (local, not in CI):** `pnpm -C packages/console exec vitest run && pnpm -C packages/console run typecheck`.
- [ ] **Drive it (per superpowers:verification):** `PORT=4321 node dist/index.js`, open `#/optimize`, switch Global→a project, confirm project skills show a checkbox + global rows show the advisory badge; disable a project skill and confirm it archives under `<root>/.agentgem/disabled`; open `#/setup`, switch scope, confirm project artifacts appear with a `project` badge.
- [ ] **Integrate:** push branch, open PR, let CI (`test (24)`+`test (26)`) gate, merge once green.

## Self-review notes

- **Spec coverage:** scope model (Tasks 4/5/7), effective merge (Task 3 `mergedInventory`), safety/owned-layer rule (Task 3 guard + Task 6 `eligible`), project usage (Task 2), API additive fields (Tasks 3/4/7), Optimize UI (Task 6), Setup UI (Task 8), tests each task, build order Optimize→Setup. ✓
- **Instructions-health + Discover stay global** per spec: Task 6 leaves the Instructions section and `DiscoverSection` untouched (they render from `data.instructions` / their own route); no scope change. In project scope `data.instructions` is the merged set — acceptable (informational). ✓
- **Known limitation (documented):** a global skill and a project skill with the *same name* share one `skill:<name>` usage key, so both rows show identical `uses`. Acceptable for MVP; note in the PR.
