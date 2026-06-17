# Harness Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add harness **targets** so a Pack can be rendered into a specific coding-agent's on-disk layout via a pure `materialize(pack, target): { files, skipped }`, with a derived compatibility summary — agentgem produces the file tree; it writes nothing.

**Architecture:** A purpose-built TOML emitter (leaf), then `src/pack/targets.ts` composing per-artifact-type **convention renderers** (`SKILL.md`/`DESCRIPTION.md`, `CLAUDE.md`/`AGENTS.md`/`SOUL.md`, `.mcp.json`/`config.toml`, `settings.json`) into four targets (claude/codex/agents/hermes). Unmappable artifacts are skipped-with-reason. Then zod schemas, a `materialize` REST/MCP op, and a UI "Materialize" preview mode. Tests assert **external fidelity** (exact paths + format-valid content), not round-trip through `introspect.ts`.

**Tech Stack:** TypeScript 6 (legacy decorators, `tsc -b`), zod v4, AgentBack, vitest, `@agentback/testing`/supertest, vanilla-JS page. pnpm.

**Conventions for every task:**
- Single test file: `pnpm exec vitest run <path>`.
- Full gate (typechecks too): `pnpm test` (`tsc -b && vitest run`). Run before each commit.
- Branch `feat/harness-targets` is already checked out. ESM `.js` import extensions, matching existing files.

---

### Task 1: Purpose-built TOML emitter for MCP config

A tiny TOML serializer for the known MCP-config shape only (command/url/type scalars, args array, env/headers sub-tables). Not a general TOML library.

**Files:**
- Create: `src/pack/toml.ts`
- Test: `src/pack/__tests__/toml.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pack/__tests__/toml.test.ts`:

```ts
// src/pack/__tests__/toml.test.ts
import { describe, it, expect } from "vitest";
import { tomlMcpServers } from "../toml.js";
import type { McpServerArtifact } from "../types.js";

const srv = (name: string, config: Record<string, unknown>): McpServerArtifact => ({ type: "mcp_server", name, transport: "stdio", config });

describe("tomlMcpServers", () => {
  it("renders a server table with command, args array, and an env sub-table", () => {
    const t = tomlMcpServers([srv("github", { command: "npx", args: ["-y", "gh"], env: { GH_TOKEN: "<redacted>", REGION: "us" } })]);
    expect(t).toContain("[mcp_servers.github]");
    expect(t).toContain('command = "npx"');
    expect(t).toContain('args = ["-y", "gh"]');
    expect(t).toContain("[mcp_servers.github.env]");
    expect(t).toContain('GH_TOKEN = "<redacted>"');
    expect(t).toContain('REGION = "us"');
  });

  it("quotes non-bareword server names and escapes special chars in strings", () => {
    const t = tomlMcpServers([srv("weird name", { command: 'a"b\\c' })]);
    expect(t).toContain('[mcp_servers."weird name"]');
    expect(t).toContain('command = "a\\"b\\\\c"');
  });

  it("returns empty string for no servers", () => {
    expect(tomlMcpServers([])).toBe("");
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/pack/__tests__/toml.test.ts`
Expected: FAIL — cannot find module `../toml.js`.

- [ ] **Step 3: Implement `src/pack/toml.ts`**

```ts
// src/pack/toml.ts
// Minimal TOML emitter for the MCP-server config shape ONLY (command/url/type scalars,
// args array, env/headers sub-tables). Not a general TOML library.
import type { McpServerArtifact } from "./types.js";

const BARE = /^[A-Za-z0-9_-]+$/;
function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
function key(k: string): string {
  return BARE.test(k) ? k : `"${escapeStr(k)}"`;
}
function scalar(v: unknown): string {
  if (typeof v === "string") return `"${escapeStr(v)}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `"${escapeStr(String(v))}"`;
}
function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

export function tomlMcpServers(servers: McpServerArtifact[]): string {
  const blocks: string[] = [];
  for (const s of servers) {
    const lines: string[] = [`[mcp_servers.${key(s.name)}]`];
    const subTables: string[] = [];
    for (const [k, v] of Object.entries(s.config)) {
      if (isScalar(v)) lines.push(`${key(k)} = ${scalar(v)}`);
      else if (Array.isArray(v)) lines.push(`${key(k)} = [${v.map(scalar).join(", ")}]`);
      else if (v && typeof v === "object") {
        const sub = [`[mcp_servers.${key(s.name)}.${key(k)}]`];
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) sub.push(`${key(k2)} = ${scalar(v2)}`);
        subTables.push(sub.join("\n"));
      }
    }
    blocks.push([lines.join("\n"), ...subTables].join("\n\n"));
  }
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}
```

- [ ] **Step 4: Run it, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/pack/__tests__/toml.test.ts` → PASS.
Run: `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pack/toml.ts src/pack/__tests__/toml.test.ts
git commit -m "feat(pack): purpose-built TOML emitter for MCP server config"
```

---

### Task 2: `targets.ts` — convention renderers, registry, materialize, compatibility

**Files:**
- Create: `src/pack/targets.ts`
- Test: `src/pack/__tests__/targets.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/pack/__tests__/targets.test.ts`:

```ts
// src/pack/__tests__/targets.test.ts
import { describe, it, expect } from "vitest";
import { materialize, compatibility, TARGET_REGISTRY } from "../targets.js";
import type { Pack, PackArtifact, SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact } from "../types.js";

const pack = (artifacts: PackArtifact[]): Pack => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): SkillArtifact => ({ type: "skill", name: n, source: "standalone", content });
const mcp = (n: string): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "stdio", config: { command: "npx", env: { TOK: "<redacted>" } } });
const instr = (n: string, content = "do this"): InstructionsArtifact => ({ type: "instructions", name: n, content });
const hook = (): HookArtifact => ({ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { matcher: "Bash", hooks: [{ type: "command", command: "x" }] }, source: "user" });

describe("materialize", () => {
  it("claude: SKILL.md, CLAUDE.md, .mcp.json, settings.json hooks; nothing skipped", () => {
    const r = materialize(pack([skill("review"), instr("CLAUDE.md"), mcp("gh"), hook()]), "claude");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["CLAUDE.md"]).toContain("do this");
    expect(JSON.parse(r.files[".mcp.json"]).mcpServers.gh.env.TOK).toBe("<redacted>");
    expect(JSON.parse(r.files["settings.json"]).hooks.PreToolUse).toBeTruthy();
    expect(r.skipped).toEqual([]);
  });

  it("codex: AGENTS.md + config.toml; hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("CLAUDE.md"), mcp("gh"), hook()]), "codex");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["AGENTS.md"]).toContain("do this");
    expect(r.files["config.toml"]).toContain("[mcp_servers.gh]");
    expect(r.files["settings.json"]).toBeUndefined();
    expect(r.skipped.map((s) => s.type)).toEqual(["hook"]);
  });

  it("agents: AGENTS.md + skills; mcp + hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("X"), mcp("gh"), hook()]), "agents");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["AGENTS.md"]).toContain("do this");
    expect(r.files[".mcp.json"]).toBeUndefined();
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("hermes: DESCRIPTION.md + SOUL.md; mcp + hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("X"), mcp("gh"), hook()]), "hermes");
    expect(r.files["skills/review/DESCRIPTION.md"]).toBe("# body");
    expect(r.files["SOUL.md"]).toContain("do this");
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("skips the later of two same-named skills (path collision); first wins", () => {
    const r = materialize(pack([skill("dup", "first"), skill("dup", "second")]), "claude");
    expect(r.files["skills/dup/SKILL.md"]).toBe("first");
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain("collision");
  });

  it("never emits a secret value", () => {
    const r = materialize(pack([mcp("gh")]), "claude");
    expect(r.files[".mcp.json"]).toContain("<redacted>");
    expect(JSON.stringify(r.files)).not.toContain("realsecret");
  });
});

describe("compatibility", () => {
  it("summarizes supported/skipped per target", () => {
    const c = compatibility(pack([skill("a"), hook()]));
    expect(c.claude).toEqual({ supported: 2, skipped: 0 });
    expect(c.codex).toEqual({ supported: 1, skipped: 1 });   // hook unsupported
    expect(c.hermes).toEqual({ supported: 1, skipped: 1 });
    expect(Object.keys(TARGET_REGISTRY).sort()).toEqual(["agents", "claude", "codex", "hermes"]);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/pack/__tests__/targets.test.ts`
Expected: FAIL — cannot find module `../targets.js`.

- [ ] **Step 3: Implement `src/pack/targets.ts`**

```ts
// src/pack/targets.ts
// Render a normalized Pack INTO a harness's on-disk layout. Pure; writes nothing — returns an
// in-memory FileTree. Targets compose shared per-artifact-type convention renderers; unmappable
// artifacts are skipped with a reason. Materialize re-renders an already-redacted Pack; the
// runner rebinds real secrets from pack.requiredSecrets at install.
import type {
  Pack, ArtifactType,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";
import { tomlMcpServers } from "./toml.js";

export type TargetId = "claude" | "codex" | "agents" | "hermes";
export type FileTree = Record<string, string>;

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }
export interface MaterializeResult { files: FileTree; skipped: SkippedArtifact[] }

interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => FileTree;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
}

// ── shared convention renderers ──
const skillSkillMd = (a: SkillArtifact): FileTree => ({ [`skills/${a.name}/SKILL.md`]: a.content });
const skillDescriptionMd = (a: SkillArtifact): FileTree => ({ [`skills/${a.name}/DESCRIPTION.md`]: a.content });

// Multiple instruction artifacts concatenate into the target's single canonical file,
// each under a "## <name>" separator so provenance survives.
const concatInstructions = (file: string) => (all: InstructionsArtifact[]): FileTree =>
  ({ [file]: all.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n") });
const instructionsClaudeMd = concatInstructions("CLAUDE.md");
const instructionsAgentsMd = concatInstructions("AGENTS.md");
const instructionsSoulMd = concatInstructions("SOUL.md");

const mcpDotMcpJson = (servers: McpServerArtifact[]): FileTree =>
  ({ ".mcp.json": JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.config])) }, null, 2) });
const mcpCodexToml = (servers: McpServerArtifact[]): FileTree =>
  ({ "config.toml": tomlMcpServers(servers) });

// Reconstruct settings.json's `.hooks` event map. HookArtifact.config IS the group object
// ({ matcher?, hooks: [...] }) captured by introspect, so we group those back under their event.
function hooksToEventMap(hooks: HookArtifact[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const h of hooks) (out[h.event] ??= []).push(h.config);
  return out;
}
const hooksSettingsJson = (hooks: HookArtifact[]): FileTree =>
  ({ "settings.json": JSON.stringify({ hooks: hooksToEventMap(hooks) }, null, 2) });

// ── targets compose the shared renderers (convergence is literal, not duplicated) ──
export const TARGET_REGISTRY: Record<TargetId, TargetSpec> = {
  claude: { id: "claude", label: "Claude", skill: skillSkillMd,       instructions: instructionsClaudeMd, mcp: mcpDotMcpJson, hook: hooksSettingsJson },
  codex:  { id: "codex",  label: "Codex",  skill: skillSkillMd,       instructions: instructionsAgentsMd, mcp: mcpCodexToml },
  agents: { id: "agents", label: "Agents", skill: skillSkillMd,       instructions: instructionsAgentsMd },
  hermes: { id: "hermes", label: "Hermes", skill: skillDescriptionMd, instructions: instructionsSoulMd },
};

export function materialize(pack: Pack, target: TargetId): MaterializeResult {
  const spec = TARGET_REGISTRY[target];
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];

  const merge = (tree: FileTree, artifact: string, type: ArtifactType) => {
    for (const [path, content] of Object.entries(tree)) {
      if (path in files) { skipped.push({ artifact, type, reason: `path collision with an earlier ${type} at ${path}` }); continue; }
      files[path] = content;
    }
  };
  const skipAll = (arr: { name: string }[], type: ArtifactType) =>
    arr.forEach((a) => skipped.push({ artifact: a.name, type, reason: `${type} unsupported on ${target}` }));

  const skills = pack.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = pack.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = pack.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const hooks = pack.artifacts.filter((a): a is HookArtifact => a.type === "hook");

  if (spec.skill) for (const s of skills) merge(spec.skill(s), s.name, "skill");
  else skipAll(skills, "skill");

  if (instr.length) {
    if (spec.instructions) merge(spec.instructions(instr), instr.map((i) => i.name).join(", "), "instructions");
    else skipAll(instr, "instructions");
  }
  if (mcp.length) {
    if (spec.mcp) merge(spec.mcp(mcp), mcp.map((m) => m.name).join(", "), "mcp_server");
    else skipAll(mcp, "mcp_server");
  }
  if (hooks.length) {
    if (spec.hook) merge(spec.hook(hooks), hooks.map((h) => h.name).join(", "), "hook");
    else skipAll(hooks, "hook");
  }

  return { files, skipped };
}

export function compatibility(pack: Pack): Record<TargetId, { supported: number; skipped: number }> {
  const out = {} as Record<TargetId, { supported: number; skipped: number }>;
  for (const id of Object.keys(TARGET_REGISTRY) as TargetId[]) {
    const r = materialize(pack, id);
    out[id] = { supported: pack.artifacts.length - r.skipped.length, skipped: r.skipped.length };
  }
  return out;
}
```

- [ ] **Step 4: Run it, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/pack/__tests__/targets.test.ts` → PASS.
Run: `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pack/targets.ts src/pack/__tests__/targets.test.ts
git commit -m "feat(pack): targets.ts — materialize a Pack per harness + compatibility"
```

---

### Task 3: Schemas for the materialize op

**Files:**
- Modify: `src/schemas.ts`
- Test: `src/__tests__/schemas.test.ts`

- [ ] **Step 1: Add failing schema tests**

In `src/__tests__/schemas.test.ts`, add `MaterializeRequestSchema, MaterializeResponseSchema` to the import from `../schemas.js`, then add inside the `describe` block:

```ts
it("validates a materialize request and rejects an unknown target", () => {
  MaterializeRequestSchema.parse({ selection: { all: true }, target: "codex" });
  expect(() => MaterializeRequestSchema.parse({ selection: { all: true }, target: "nope" })).toThrow();
});

it("validates a materialize response shape", () => {
  const r = MaterializeResponseSchema.parse({
    target: "claude",
    files: { "CLAUDE.md": "x" },
    skipped: [{ artifact: "h", type: "hook", reason: "hook unsupported on claude" }],
    compatibility: {
      claude: { supported: 1, skipped: 0 }, codex: { supported: 0, skipped: 1 },
      agents: { supported: 0, skipped: 1 }, hermes: { supported: 0, skipped: 1 },
    },
  });
  expect(r.files["CLAUDE.md"]).toBe("x");
  expect(r.skipped[0].type).toBe("hook");
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/__tests__/schemas.test.ts`
Expected: FAIL — `MaterializeRequestSchema` / `MaterializeResponseSchema` not exported.

- [ ] **Step 3: Add the schemas**

In `src/schemas.ts`, add this import below the existing `import { RUNNER_REGISTRY } from "./pack/checks.js";`:

```ts
import { TARGET_REGISTRY } from "./pack/targets.js";
```

Add these schemas after `ScaffoldChecksResponseSchema`:

```ts
const TARGET_IDS = Object.keys(TARGET_REGISTRY) as [string, ...string[]];
export const TargetIdSchema = z.enum(TARGET_IDS);

export const SkippedArtifactSchema = z.object({
  artifact: z.string(),
  type: z.enum(["skill", "mcp_server", "instructions", "hook"]),
  reason: z.string(),
});

export const MaterializeRequestSchema = z.object({
  selection: PackSelectionSchema,
  target: TargetIdSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
});

export const MaterializeResponseSchema = z.object({
  target: TargetIdSchema,
  files: z.record(z.string(), z.string()),
  skipped: z.array(SkippedArtifactSchema),
  compatibility: z.record(TargetIdSchema, z.object({ supported: z.number(), skipped: z.number() })),
});
```

- [ ] **Step 4: Run it, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/__tests__/schemas.test.ts` → PASS.
Run: `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(pack): zod schemas for the materialize op (target-validated)"
```

---

### Task 4: Controller — `materialize` op (REST + MCP)

**Files:**
- Modify: `src/pack.controller.ts`
- Test: `src/__tests__/pack.controller.test.ts`

- [ ] **Step 1: Add a failing controller test**

In `src/__tests__/pack.controller.test.ts`, add inside `describe("PackController", ...)` (the `beforeAll` seeds a `review` skill and a `gh` MCP server with `env.GH_TOKEN: "ghp_secret"`):

```ts
it("POST /api/materialize renders the target layout + compatibility, no secret values", async () => {
  const r = await client
    .post("/api/materialize")
    .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"] }, target: "codex" })
    .expect(200);
  expect(r.body.target).toBe("codex");
  expect(r.body.files["skills/review/SKILL.md"]).toBeTruthy();
  expect(r.body.files["config.toml"]).toContain("[mcp_servers.gh]");
  expect(r.body.compatibility.codex).toBeTruthy();
  expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // secret value never present
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/__tests__/pack.controller.test.ts`
Expected: FAIL — `/api/materialize` 404s.

- [ ] **Step 3: Implement the controller change**

In `src/pack.controller.ts`, add the targets import (next to the existing `scaffoldChecks` import):

```ts
import { materialize, compatibility } from "./pack/targets.js";
```

Add the two schema names to the existing schemas import block:

```ts
  MaterializeRequestSchema, MaterializeResponseSchema,
```

Add this method after the existing `scaffoldChecks` method (the `materialize` method name shadows the imported `materialize` function inside its body — same established pattern as `pickFolder`/`scaffoldChecks`):

```ts
  @post("/materialize", { body: MaterializeRequestSchema, response: MaterializeResponseSchema })
  async materialize(input: { body: z.infer<typeof MaterializeRequestSchema> }): Promise<z.infer<typeof MaterializeResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    return { target: input.body.target, ...materialize(pack, input.body.target), compatibility: compatibility(pack) };
  }
```

- [ ] **Step 4: Run it, watch it pass; then the full gate**

Run: `pnpm exec vitest run src/__tests__/pack.controller.test.ts` → PASS.
Run: `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pack.controller.ts src/__tests__/pack.controller.test.ts
git commit -m "feat(api): materialize op renders a pack per harness target (REST + MCP)"
```

---

### Task 5: Page — target selector + "Materialize" preview mode

Adds a target `<select>` and a third preview mode that renders the materialized file tree, a skipped banner, and a compatibility strip. Browser-smoke-tested by the session controller (no vitest).

**Files:**
- Modify: `src/public/index.html`

Read the file first. Landmarks: the right-pane bar `<div class="bar"><strong style="flex:1">Pack (live)</strong><span class="seg" id="preview-modes">…</span>…</div>` (~line 82); `let previewMode = "summary";` and `function renderPreview(){…}` (~lines 300, 321); the `#preview` click handler that opens artifacts via `.prow` (~line 346); `buildSelectionBody()` already exists (from the checks feature).

- [ ] **Step 1: Add the target select + Materialize mode button**

In the right-pane bar, change the `#preview-modes` span to add a Materialize button, and add a target select right before it. Replace:

```html
<span class="seg" id="preview-modes"><button type="button" data-pmode="summary">Summary</button><button type="button" data-pmode="json">JSON</button></span>
```

with:

```html
<select id="target" title="materialize target" style="margin-left:auto"><option value="claude">Claude</option><option value="codex">Codex</option><option value="agents">Agents</option><option value="hermes">Hermes</option></select><span class="seg" id="preview-modes"><button type="button" data-pmode="summary">Summary</button><button type="button" data-pmode="json">JSON</button><button type="button" data-pmode="materialize">Materialize</button></span>
```

(The `#preview-modes` span currently has `margin-left:auto` via CSS `.seg`; moving `margin-left:auto` onto the `#target` select keeps the right-alignment.)

- [ ] **Step 2: Route the Materialize mode + add the renderer**

Find `function renderPreview(){` and insert this guard as its FIRST statement (right after the opening brace and the `const el = ...` line), so materialize mode short-circuits the synchronous render:

```js
  if (previewMode === "materialize") { renderMaterialize(); document.querySelectorAll("#preview-modes button").forEach(b => b.classList.toggle("on", b.dataset.pmode === previewMode)); return; }
```

Then add these functions immediately AFTER the `renderPreview` function:

```js
async function renderMaterialize(){
  const el = document.getElementById("preview");
  const reqBody = buildSelectionBody();
  reqBody.target = document.getElementById("target").value;
  const m = await (await fetch("/api/materialize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqBody) })).json();
  window.__materialize = m;
  if (m.error) { el.innerHTML = ""; const pre = document.createElement("pre"); pre.className = "json"; pre.textContent = JSON.stringify(m, null, 2); el.appendChild(pre); return; }
  const paths = Object.keys(m.files || {});
  const compat = Object.entries(m.compatibility || {}).map(([t, c]) => `${t} ${c.skipped ? c.skipped + " skipped" : "✓"}`).join(" · ");
  let h = `<div class="psummary"><div class="phead"><strong>${esc(m.target)}</strong> <span class="d">· ${paths.length} file${paths.length === 1 ? "" : "s"}</span></div>`;
  h += `<div class="pgroup"><h3>Files</h3>` + (paths.length ? paths.map(p => `<button type="button" class="prow" data-mpath="${esc(p)}"><span class="pn">${esc(p)}</span></button>`).join("") : `<p class="d">No files — select artifacts on the left.</p>`) + `</div>`;
  if ((m.skipped || []).length) h += `<div class="pgroup"><h3>Skipped (${m.skipped.length})</h3>` + m.skipped.map(s => `<div class="prow"><span class="pn">${esc(s.artifact)}</span> <span class="pm">${esc(s.reason)}</span></div>`).join("") + `</div>`;
  h += `<p class="note">Compatibility: ${esc(compat)}</p></div>`;
  el.innerHTML = h;
}
function openMaterializedFile(path){
  const body = (window.__materialize && window.__materialize.files || {})[path] || "";
  modalState.kind = (path.endsWith(".json") || path.endsWith(".toml")) ? "mcpServers" : "skills";
  modalState.body = body;
  document.getElementById("modal-title").textContent = path;
  document.getElementById("modal-sub").textContent = (window.__materialize && window.__materialize.target) || "";
  renderModalBody();
  document.getElementById("modal").hidden = false;
}
```

- [ ] **Step 3: Open materialized files on click + re-render on target change**

In the existing `#preview` click handler (`document.getElementById("preview").addEventListener("click", e => { ... })`), add this as the FIRST statement inside the handler (before the existing `.prow` artifact lookup, so file rows are handled first):

```js
  const mp = e.target.closest("[data-mpath]");
  if (mp) { openMaterializedFile(mp.dataset.mpath); return; }
```

Then add a target-select listener near the other listeners (e.g. right after the `preview-modes` click listener):

```js
document.getElementById("target").addEventListener("change", () => { if (previewMode === "materialize") renderPreview(); });
```

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: succeeds (`tsc -b` then copies `src/public/index.html` → `dist/public/index.html`). No error.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): target selector + Materialize preview (file tree, skipped, compatibility)"
```

- [ ] **Step 6: Browser smoke (performed by the session controller, not the subagent)**

With `pnpm start` running, drive the gstack browser and confirm:
1. Tick a skill + an MCP server on the left.
2. Choose target **Codex**, click the **Materialize** preview mode.
3. The Files list shows `skills/<name>/SKILL.md`, `AGENTS.md`, and `config.toml`; a "Skipped" section appears only if hooks are selected; the Compatibility strip shows all four targets.
4. Click `config.toml` → the modal shows `[mcp_servers.<name>]` TOML with `<redacted>` values (no raw secret).
5. Switch target to **Hermes** → Files show `DESCRIPTION.md` + `SOUL.md`, MCP listed under Skipped.

---

## Verification checklist (after all tasks)

- [ ] `pnpm test` green (typecheck + all unit/controller tests).
- [ ] `GET /openapi.json` lists `POST /api/materialize`.
- [ ] A `materialize` response round-trips through `MaterializeResponseSchema`.
- [ ] No secret value appears in any materialized file (`.mcp.json` / `config.toml` carry `<redacted>` only).
