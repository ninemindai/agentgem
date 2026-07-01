# Optimize Disable / Re-enable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users multi-select unused skills/MCP in the Optimize ▸ Prune table and disable them in one action — fully reversibly — with a Disabled section to Re-enable.

**Architecture:** A new write-twin of `introspect.ts` in `@agentgem/capture` (`disableArtifact.ts`) performs reversible deactivation per artifact: plugins flip `enabledPlugins[X]=false`; `.mcp.json` MCP toggle `disabledMcpjsonServers`; standalone skills and `settings.json` MCP relocate into `~/.agentgem/disabled/` (archive path encodes provenance, so re-enable is exact). Two controller endpoints (`/api/optimize/disable`, `/api/optimize/enable`) delegate to it; the existing `GET /api/optimize` payload gains a `disabled[]` list. The Prune table gets checkboxes + a "Disable selected" button and a new Disabled section.

**Tech Stack:** TypeScript, Node fs, Zod, `@agentback/openapi` decorators, React + Vitest (jsdom for console, node for core).

## Global Constraints

- Reversible only — never delete/overwrite a skill or config entry. Relocation + flags only. (verbatim from spec)
- Consistent across coding agents: the write path reuses the exact `source → skills root` mapping used by `introspect.ts` for `standalone`/`agent`/`codex`/`hermes`. A shared helper is the single source of truth.
- Archive root is agent-neutral: `<base>/.agentgem/disabled/` where `base = opts.claudeDir ? dirname(opts.claudeDir) : agentgemHome()` — mirrors `introspect.ts`'s distilled-base convention exactly (testable via `claudeDir` override).
- Never-throws batch: each item processed independently; failures map to `{ ok:false, message }`; the batch endpoint never rejects (mirrors `installSkill`).
- Strict validation before any filesystem move: `name`/`source` regex-checked and `..` rejected (defense-in-depth, identical posture to `installSkill`).
- Ineligible sources (`distilled-draft`, `project`) are excluded — no checkbox, no action.
- Git identity for every commit: `Raymond Feng <raymond@ninemind.ai>`.
- Tests live at repo-root `src/gem/__tests__/*.test.ts` (core) and `packages/console/src/**/*.test.tsx` (UI). Root vitest runs compiled `dist/**/__tests__/**/*.test.js` — build (`pnpm build` or `tsc -b`) before running root tests.

---

### Task 1: Shared skill-root resolver

**Files:**
- Create: `packages/capture/src/skillRoots.ts`
- Modify: `packages/capture/src/introspect.ts` (route its 4 non-plugin skill reads through the helper)
- Modify: `packages/capture/src/index.ts` (export the helper)

**Interfaces:**
- Produces: `SKILL_SOURCES: readonly ["standalone","agent","codex","hermes"]`; `type SkillSource`; `interface SkillRootOptions { claudeDir?, agentDir?, codexDir?, hermesDir? }`; `resolveSkillRoot(source: SkillSource, opts?: SkillRootOptions): string`.

- [ ] **Step 1: Write `skillRoots.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/skillRoots.ts
//
// Single source of truth for the source → on-disk skills-root mapping, shared by the
// reader (introspect.ts) and the writer (disableArtifact.ts) so the two never drift.
// Only the four non-plugin, globally-installed skill sources live here; plugin skills
// (installPath/skills) and distilled drafts are resolved elsewhere.
import { homedir } from "node:os";
import { join } from "node:path";

export const SKILL_SOURCES = ["standalone", "agent", "codex", "hermes"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillRootOptions {
  claudeDir?: string;
  agentDir?: string;
  codexDir?: string;
  hermesDir?: string;
}

// Defaults match introspect.ts exactly: ~/.claude/skills, ~/.agents/skills,
// ~/.codex/skills, ~/.hermes/skills.
export function resolveSkillRoot(source: SkillSource, opts: SkillRootOptions = {}): string {
  const home = homedir();
  const claudeDir = opts.claudeDir ?? join(home, ".claude");
  const agentDir = opts.agentDir ?? join(home, ".agents", "skills");
  const codexDir = opts.codexDir ?? join(home, ".codex");
  const hermesDir = opts.hermesDir ?? join(home, ".hermes");
  switch (source) {
    case "standalone": return join(claudeDir, "skills");
    case "agent": return agentDir;
    case "codex": return join(codexDir, "skills");
    case "hermes": return join(hermesDir, "skills");
  }
}
```

- [ ] **Step 2: Route introspect's 4 skill reads through the helper**

In `packages/capture/src/introspect.ts`, add to the imports:

```ts
import { resolveSkillRoot } from "./skillRoots.js";
```

Then in `introspectConfig`, the locals `claudeDir/agentDir/codexDir/hermesDir` are already computed. Replace these four call sites so the roots come from the helper (behavior-identical; guarded by existing introspect tests):

```ts
// was: readSkillsDir(join(claudeDir, "skills"), "standalone")
skillList.push(...readSkillsDir(resolveSkillRoot("standalone", { claudeDir, agentDir, codexDir, hermesDir }), "standalone"));
// ...
// was: readSkillsDir(agentDir, "agent")
skillList.push(...readSkillsDir(resolveSkillRoot("agent", { claudeDir, agentDir, codexDir, hermesDir }), "agent"));
// was: readSkillsDir(join(codexDir, "skills"), "codex")
skillList.push(...readSkillsDir(resolveSkillRoot("codex", { claudeDir, agentDir, codexDir, hermesDir }), "codex"));
// was: readSkillsDir(join(hermesDir, "skills"), "hermes", ["SKILL.md", "DESCRIPTION.md"])
skillList.push(...readSkillsDir(resolveSkillRoot("hermes", { claudeDir, agentDir, codexDir, hermesDir }), "hermes", ["SKILL.md", "DESCRIPTION.md"]));
```

Keep each call at its original position (the standalone read stays first, hermes stays after codex). Do not touch the plugin or distilled-draft reads.

- [ ] **Step 3: Export from the package index**

In `packages/capture/src/index.ts` add:

```ts
export * from "./skillRoots.js";
```

- [ ] **Step 4: Build and run the existing introspect tests (regression guard)**

Run:
```bash
pnpm build && npx vitest run src/gem/__tests__/introspect.redact.test.ts src/gem/__tests__/introspectProject.test.ts
```
Expected: PASS (unchanged behavior). If root vitest globs by compiled path, run `npx vitest run -t introspect` after build.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/skillRoots.ts packages/capture/src/introspect.ts packages/capture/src/index.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(capture): shared skill-root resolver for reader+writer parity"
```

---

### Task 2: Disable/enable core — skills (all four agents)

**Files:**
- Create: `packages/capture/src/disableArtifact.ts`
- Modify: `packages/capture/src/index.ts` (export it)
- Test: `src/gem/__tests__/disableArtifact.test.ts`

**Interfaces:**
- Consumes: `SKILL_SOURCES`, `SkillSource`, `resolveSkillRoot` (Task 1); `agentgemHome` from `@agentgem/model`.
- Produces:
  - `type ArtifactType = "skill" | "mcp" | "plugin"`
  - `interface DisableOptions { claudeDir?, agentDir?, codexDir?, hermesDir? }`
  - `interface DisableItem { type: ArtifactType; name: string; source: string }`
  - `interface DisableResult { type: ArtifactType; name: string; ok: boolean; message: string }`
  - `interface DisabledArtifact { type: ArtifactType; name: string; source: string }`
  - `disableArtifacts(items: DisableItem[], opts?: DisableOptions): DisableResult[]`
  - `enableArtifacts(items: DisableItem[], opts?: DisableOptions): DisableResult[]`
  - `listDisabled(opts?: DisableOptions): DisabledArtifact[]`
  - (Task 2 lands the skill branch of all three; Tasks 3–4 add plugin/mcp branches.)

- [ ] **Step 1: Write the failing test (skill round-trip for every agent)**

Create `src/gem/__tests__/disableArtifact.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, enableArtifacts, listDisabled } from "@agentgem/capture";

let home: string;
let opts: { claudeDir: string; agentDir: string; codexDir: string; hermesDir: string };

// The four skill roots, keyed by source, under one temp home (mirrors introspect defaults).
function rootFor(source: string): string {
  return {
    standalone: join(opts.claudeDir, "skills"),
    agent: opts.agentDir,
    codex: join(opts.codexDir, "skills"),
    hermes: join(opts.hermesDir, "skills"),
  }[source]!;
}
function seedSkill(source: string, name: string, body = "SKILL.md") {
  const dir = join(rootFor(source), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, body), `---\ndescription: ${name}\n---\n# ${name}`);
}
const archiveSkill = (source: string, name: string) => join(home, ".agentgem", "disabled", "skills", source, name);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "disable-"));
  opts = {
    claudeDir: join(home, ".claude"),
    agentDir: join(home, ".agents", "skills"),
    codexDir: join(home, ".codex"),
    hermesDir: join(home, ".hermes"),
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("disableArtifacts / enableArtifacts — skills", () => {
  it("round-trips a skill for every agent source", () => {
    for (const [source, body] of [["standalone", "SKILL.md"], ["agent", "SKILL.md"], ["codex", "SKILL.md"], ["hermes", "DESCRIPTION.md"]] as const) {
      seedSkill(source, "demo", body);
      const [d] = disableArtifacts([{ type: "skill", name: "demo", source }], opts);
      expect(d.ok).toBe(true);
      expect(existsSync(join(rootFor(source), "demo"))).toBe(false);   // gone from live root
      expect(existsSync(join(archiveSkill(source, "demo"), body))).toBe(true); // archived, folder intact
      const [e] = enableArtifacts([{ type: "skill", name: "demo", source }], opts);
      expect(e.ok).toBe(true);
      expect(existsSync(join(rootFor(source), "demo", body))).toBe(true); // restored
      expect(existsSync(archiveSkill(source, "demo"))).toBe(false);
    }
  });

  it("keeps same-named skills from different agents in distinct archive namespaces", () => {
    seedSkill("standalone", "dup"); seedSkill("codex", "dup");
    disableArtifacts([{ type: "skill", name: "dup", source: "standalone" }, { type: "skill", name: "dup", source: "codex" }], opts);
    expect(existsSync(archiveSkill("standalone", "dup"))).toBe(true);
    expect(existsSync(archiveSkill("codex", "dup"))).toBe(true);
    const disabled = listDisabled(opts);
    expect(disabled.filter((d) => d.type === "skill" && d.name === "dup")).toHaveLength(2);
  });

  it("rejects a traversal name without moving anything", () => {
    const [r] = disableArtifacts([{ type: "skill", name: "../evil", source: "standalone" }], opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid/i);
    expect(existsSync(join(home, ".agentgem"))).toBe(false);
  });

  it("fails cleanly when the archive target already exists (no clobber)", () => {
    seedSkill("standalone", "demo");
    mkdirSync(archiveSkill("standalone", "demo"), { recursive: true }); // pre-existing archive
    const [r] = disableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already archived/i);
    expect(existsSync(join(rootFor("standalone"), "demo"))).toBe(true); // untouched
  });

  it("processes the rest of a batch when one item is bad", () => {
    seedSkill("standalone", "good");
    const res = disableArtifacts([
      { type: "skill", name: "missing", source: "standalone" },
      { type: "skill", name: "good", source: "standalone" },
    ], opts);
    expect(res[0].ok).toBe(false);
    expect(res[1].ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run src/gem/__tests__/disableArtifact.test.ts`
Expected: FAIL (module `disableArtifact` / exports not found).

- [ ] **Step 3: Write `disableArtifact.ts` (skill branch of all three functions)**

Create `packages/capture/src/disableArtifact.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/disableArtifact.ts
//
// Reversible deactivation — the write-twin of introspect.ts. Every operation is
// undoable: skills and settings.json MCP relocate into <base>/.agentgem/disabled/
// (the archive path encodes provenance), while plugins and .mcp.json MCP flip a flag.
// Never throws: each item degrades to { ok:false, message }, matching installSkill.
import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { agentgemHome } from "@agentgem/model";
import { SKILL_SOURCES, resolveSkillRoot, type SkillSource } from "./skillRoots.js";

export type ArtifactType = "skill" | "mcp" | "plugin";
export interface DisableOptions { claudeDir?: string; agentDir?: string; codexDir?: string; hermesDir?: string }
export interface DisableItem { type: ArtifactType; name: string; source: string }
export interface DisableResult { type: ArtifactType; name: string; ok: boolean; message: string }
export interface DisabledArtifact { type: ArtifactType; name: string; source: string }

const NAME_RE = /^[\w.@-]+$/;       // skill/mcp/plugin identifiers
const SOURCE_RE = /^[\w.:@/-]+$/;   // "standalone", "user", "plugin:brooks-lint"

function invalid(name: string, source: string): boolean {
  return !NAME_RE.test(name) || !SOURCE_RE.test(source) || name.includes("..") || source.includes("..");
}
function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
// Base for the archive mirrors introspect.ts's distilled-base rule so a claudeDir
// override (tests) keeps everything self-contained under one temp home.
function archiveRoot(opts: DisableOptions): string {
  const base = opts.claudeDir ? dirname(opts.claudeDir) : agentgemHome();
  return join(base, ".agentgem", "disabled");
}
function claudeConfigDir(opts: DisableOptions): string {
  return opts.claudeDir ?? join(homedir(), ".claude");
}
function settingsPath(opts: DisableOptions): string {
  return join(claudeConfigDir(opts), "settings.json");
}

export function disableArtifacts(items: DisableItem[], opts: DisableOptions = {}): DisableResult[] {
  return items.map((it) => disableOne(it, opts));
}
export function enableArtifacts(items: DisableItem[], opts: DisableOptions = {}): DisableResult[] {
  return items.map((it) => enableOne(it, opts));
}

function disableOne(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  try {
    if (invalid(it.name, it.source)) return { ...base, ok: false, message: "invalid artifact reference" };
    if (it.source.startsWith("plugin:")) return disablePlugin(it, opts);   // Task 3
    if (it.type === "skill") return disableSkill(it, opts);
    if (it.type === "mcp") return disableMcp(it, opts);                     // Task 4
    return { ...base, ok: false, message: `cannot disable ${it.type}` };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message || "disable failed" };
  }
}
function enableOne(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  try {
    if (invalid(it.name, it.source)) return { ...base, ok: false, message: "invalid artifact reference" };
    if (it.type === "plugin" || it.source.startsWith("plugin:")) return enablePlugin(it, opts); // Task 3
    if (it.type === "skill") return enableSkill(it, opts);
    if (it.type === "mcp") return enableMcp(it, opts);                      // Task 4
    return { ...base, ok: false, message: `cannot enable ${it.type}` };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message || "enable failed" };
  }
}

// ── skills: relocate the whole folder out of / back into the live skills root ──
function disableSkill(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  if (!SKILL_SOURCES.includes(it.source as SkillSource)) {
    return { ...base, ok: false, message: `source ${it.source} is not disable-eligible` };
  }
  const source = it.source as SkillSource;
  const from = join(resolveSkillRoot(source, opts), it.name);
  if (!existsSync(from)) return { ...base, ok: false, message: `skill folder not found: ${from}` };
  const to = join(archiveRoot(opts), "skills", source, it.name);
  if (existsSync(to)) return { ...base, ok: false, message: `already archived at ${to}` };
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { ...base, ok: true, message: `disabled (archived to ${to})` };
}
function enableSkill(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  if (!SKILL_SOURCES.includes(it.source as SkillSource)) {
    return { ...base, ok: false, message: `source ${it.source} is not disable-eligible` };
  }
  const source = it.source as SkillSource;
  const from = join(archiveRoot(opts), "skills", source, it.name);
  if (!existsSync(from)) return { ...base, ok: false, message: `not archived: ${from}` };
  const to = join(resolveSkillRoot(source, opts), it.name);
  if (existsSync(to)) return { ...base, ok: false, message: `already present: ${to}` };
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { ...base, ok: true, message: `re-enabled (restored to ${to})` };
}

// ── plugin branch: Task 3 replaces these stubs ──
function disablePlugin(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "plugin disable not implemented" };
}
function enablePlugin(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "plugin enable not implemented" };
}
// ── mcp branch: Task 4 replaces these stubs ──
function disableMcp(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "mcp disable not implemented" };
}
function enableMcp(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "mcp enable not implemented" };
}

// ── enumerate everything currently disabled (skill archive only in Task 2; Tasks 3–4 extend) ──
export function listDisabled(opts: DisableOptions = {}): DisabledArtifact[] {
  const out: DisabledArtifact[] = [];
  const skillsRoot = join(archiveRoot(opts), "skills");
  for (const source of SKILL_SOURCES) {
    const dir = join(skillsRoot, source);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) out.push({ type: "skill", name, source });
  }
  return out;
}
```

- [ ] **Step 4: Export from the package index**

In `packages/capture/src/index.ts` add:

```ts
export * from "./disableArtifact.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm build && npx vitest run src/gem/__tests__/disableArtifact.test.ts`
Expected: PASS (all skill tests green; plugin/mcp stubs not yet exercised).

- [ ] **Step 6: Commit**

```bash
git add packages/capture/src/disableArtifact.ts packages/capture/src/index.ts src/gem/__tests__/disableArtifact.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(capture): reversible skill disable/enable via archive relocation"
```

---

### Task 3: Plugin disable/enable (flag flip)

**Files:**
- Modify: `packages/capture/src/disableArtifact.ts` (replace `disablePlugin`/`enablePlugin` stubs; extend `listDisabled`)
- Test: `src/gem/__tests__/disableArtifact.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `readJson`/`writeJson`/`settingsPath` (Task 2, same module).
- Produces: plugin rows in `listDisabled` as `{ type:"plugin", name:<key>, source:\`plugin:<key>\` }`.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/disableArtifact.test.ts`:

```ts
describe("plugin disable/enable", () => {
  const settingsFile = () => join(opts.claudeDir, "settings.json");
  const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

  beforeEach(() => {
    mkdirSync(opts.claudeDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ enabledPlugins: { "brooks-lint": true }, someOther: 1 }));
  });

  it("disables a plugin-sourced row by flipping the flag, preserving other keys", () => {
    const [r] = disableArtifacts([{ type: "skill", name: "brooks-review", source: "plugin:brooks-lint" }], opts);
    expect(r.ok).toBe(true);
    const s = readSettings();
    expect(s.enabledPlugins["brooks-lint"]).toBe(false);
    expect(s.someOther).toBe(1); // untouched
  });

  it("lists a disabled plugin and re-enables it", () => {
    disableArtifacts([{ type: "skill", name: "brooks-review", source: "plugin:brooks-lint" }], opts);
    const disabled = listDisabled(opts);
    expect(disabled).toContainEqual({ type: "plugin", name: "brooks-lint", source: "plugin:brooks-lint" });
    const [e] = enableArtifacts([{ type: "plugin", name: "brooks-lint", source: "plugin:brooks-lint" }], opts);
    expect(e.ok).toBe(true);
    expect(readSettings().enabledPlugins["brooks-lint"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run src/gem/__tests__/disableArtifact.test.ts -t plugin`
Expected: FAIL ("plugin disable not implemented").

- [ ] **Step 3: Implement the plugin branch**

In `packages/capture/src/disableArtifact.ts`, replace the two plugin stubs:

```ts
// ── plugins: reversible via settings.json enabledPlugins flag ──
function disablePlugin(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  const key = it.source.slice("plugin:".length);
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  obj.enabledPlugins = { ...(obj.enabledPlugins ?? {}), [key]: false };
  writeJson(p, obj);
  return { ...base, ok: true, message: `plugin ${key} disabled` };
}
function enablePlugin(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  // name carries the plugin key for a "plugin"-typed row; source carries it otherwise.
  const key = it.source.startsWith("plugin:") ? it.source.slice("plugin:".length) : it.name;
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  obj.enabledPlugins = { ...(obj.enabledPlugins ?? {}), [key]: true };
  writeJson(p, obj);
  return { ...base, ok: true, message: `plugin ${key} re-enabled` };
}
```

Then extend `listDisabled` — add, before the `return out;`:

```ts
  const settings = readJson(settingsPath(opts));
  const enabled = settings && typeof settings === "object" && settings.enabledPlugins && typeof settings.enabledPlugins === "object"
    ? settings.enabledPlugins as Record<string, unknown> : {};
  for (const [key, v] of Object.entries(enabled)) {
    if (v === false) out.push({ type: "plugin", name: key, source: `plugin:${key}` });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run src/gem/__tests__/disableArtifact.test.ts`
Expected: PASS (skill + plugin blocks green).

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/disableArtifact.ts src/gem/__tests__/disableArtifact.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(capture): plugin disable/enable via enabledPlugins flag"
```

---

### Task 4: MCP disable/enable (both origins) + full listDisabled

**Files:**
- Modify: `packages/capture/src/disableArtifact.ts` (replace `disableMcp`/`enableMcp` stubs; finish `listDisabled`)
- Test: `src/gem/__tests__/disableArtifact.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `readJson`/`writeJson`/`settingsPath`/`claudeConfigDir`/`archiveRoot` (Task 2).
- Produces: mcp rows in `listDisabled` from both `disabledMcpjsonServers` and the `<archive>/mcp/*.json` stash, as `{ type:"mcp", name, source:"user" }`.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/disableArtifact.test.ts`:

```ts
describe("mcp disable/enable", () => {
  const settingsFile = () => join(opts.claudeDir, "settings.json");
  const mcpJsonFile = () => join(opts.claudeDir, ".mcp.json");
  const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));
  const stashFile = (name: string) => join(home, ".agentgem", "disabled", "mcp", `${name}.json`);

  beforeEach(() => mkdirSync(opts.claudeDir, { recursive: true }));

  it("stashes and restores a settings.json-defined MCP server", () => {
    writeFileSync(settingsFile(), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["gh-mcp"] } } }));
    const [d] = disableArtifacts([{ type: "mcp", name: "gh", source: "user" }], opts);
    expect(d.ok).toBe(true);
    expect(readSettings().mcpServers.gh).toBeUndefined();          // removed from live config
    expect(JSON.parse(readFileSync(stashFile("gh"), "utf8")).config.args).toEqual(["gh-mcp"]); // stashed
    expect(listDisabled(opts)).toContainEqual({ type: "mcp", name: "gh", source: "user" });
    const [e] = enableArtifacts([{ type: "mcp", name: "gh", source: "user" }], opts);
    expect(e.ok).toBe(true);
    expect(readSettings().mcpServers.gh.args).toEqual(["gh-mcp"]); // restored
    expect(existsSync(stashFile("gh"))).toBe(false);              // stash cleaned up
  });

  it("toggles disabledMcpjsonServers for a .mcp.json-defined server", () => {
    writeFileSync(settingsFile(), JSON.stringify({}));
    writeFileSync(mcpJsonFile(), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["fs-mcp"] } } }));
    const [d] = disableArtifacts([{ type: "mcp", name: "fs", source: "user" }], opts);
    expect(d.ok).toBe(true);
    expect(readSettings().disabledMcpjsonServers).toContain("fs");
    expect(listDisabled(opts)).toContainEqual({ type: "mcp", name: "fs", source: "user" });
    const [e] = enableArtifacts([{ type: "mcp", name: "fs", source: "user" }], opts);
    expect(e.ok).toBe(true);
    expect(readSettings().disabledMcpjsonServers).not.toContain("fs");
  });

  it("fails cleanly for an MCP name in neither config", () => {
    writeFileSync(settingsFile(), JSON.stringify({}));
    const [r] = disableArtifacts([{ type: "mcp", name: "ghost", source: "user" }], opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run src/gem/__tests__/disableArtifact.test.ts -t mcp`
Expected: FAIL ("mcp disable not implemented").

- [ ] **Step 3: Implement the MCP branch**

In `packages/capture/src/disableArtifact.ts`, replace the two mcp stubs:

```ts
// ── mcp: settings.json entries are stashed (reversible); .mcp.json servers use a flag ──
function mcpJsonServers(opts: DisableOptions): Record<string, unknown> {
  const parsed = readJson(join(claudeConfigDir(opts), ".mcp.json"));
  if (!parsed || typeof parsed !== "object") return {};
  const servers = (parsed as any).mcpServers;
  if (servers && typeof servers === "object") return servers;
  return parsed as Record<string, unknown>;
}
function disableMcp(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  const servers = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : undefined;
  if (servers && it.name in servers) {
    const stash = join(archiveRoot(opts), "mcp", `${it.name}.json`);
    if (existsSync(stash)) return { ...base, ok: false, message: `already stashed at ${stash}` };
    writeJson(stash, { name: it.name, config: servers[it.name] });
    delete servers[it.name];
    obj.mcpServers = servers;
    writeJson(p, obj);
    return { ...base, ok: true, message: `mcp ${it.name} disabled (stashed)` };
  }
  if (it.name in mcpJsonServers(opts)) {
    const list: string[] = Array.isArray(obj.disabledMcpjsonServers) ? obj.disabledMcpjsonServers : [];
    if (!list.includes(it.name)) list.push(it.name);
    obj.disabledMcpjsonServers = list;
    writeJson(p, obj);
    return { ...base, ok: true, message: `mcp ${it.name} disabled (flagged)` };
  }
  return { ...base, ok: false, message: `mcp ${it.name} not found in settings.json or .mcp.json` };
}
function enableMcp(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  const stash = join(archiveRoot(opts), "mcp", `${it.name}.json`);
  if (existsSync(stash)) {
    const saved = readJson(stash);
    const servers = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {};
    if (it.name in servers) return { ...base, ok: false, message: `already present in mcpServers` };
    servers[it.name] = saved?.config ?? {};
    obj.mcpServers = servers;
    writeJson(p, obj);
    rmSync(stash, { force: true });
    return { ...base, ok: true, message: `mcp ${it.name} restored` };
  }
  const list: string[] = Array.isArray(obj.disabledMcpjsonServers) ? obj.disabledMcpjsonServers : [];
  if (list.includes(it.name)) {
    obj.disabledMcpjsonServers = list.filter((n) => n !== it.name);
    writeJson(p, obj);
    return { ...base, ok: true, message: `mcp ${it.name} re-enabled` };
  }
  return { ...base, ok: false, message: `mcp ${it.name} is not disabled` };
}
```

Then finish `listDisabled` — add, before `return out;` (after the plugin loop from Task 3):

```ts
  const disabledMcpjson = settings && typeof settings === "object" && Array.isArray(settings.disabledMcpjsonServers)
    ? settings.disabledMcpjsonServers as string[] : [];
  for (const name of disabledMcpjson) out.push({ type: "mcp", name, source: "user" });
  const mcpStash = join(archiveRoot(opts), "mcp");
  if (existsSync(mcpStash)) {
    for (const f of readdirSync(mcpStash)) {
      if (f.endsWith(".json")) out.push({ type: "mcp", name: f.replace(/\.json$/, ""), source: "user" });
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run src/gem/__tests__/disableArtifact.test.ts`
Expected: PASS (skills + plugin + mcp all green).

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/disableArtifact.ts src/gem/__tests__/disableArtifact.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(capture): mcp disable/enable (settings stash + .mcp.json flag) and full listDisabled"
```

---

### Task 5: API — routes, controller endpoints, payload `disabled`

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add schemas/routes; extend `OptimizePayloadSchema`)
- Modify: `src/gem.controller.ts` (import capture fns; mirror schemas; add 2 endpoints; extend `optimize()` + `OptimizePayloadSchema`)
- Test: `src/gem/__tests__/disableEndpoints.test.ts`

**Interfaces:**
- Consumes: `disableArtifacts`, `enableArtifacts`, `listDisabled`, `DisableItem`, `DisabledArtifact` from `@agentgem/capture` (Tasks 2–4); `buildOptimizePayload` (existing).
- Produces (console `routes.ts`): `DisableItemSchema`, `DisableResultSchema`, `DisabledArtifactSchema`, `disableArtifactsRoute`, `enableArtifactsRoute`; `OptimizePayload.disabled: DisabledArtifact[]`.

- [ ] **Step 1: Extend the console contract in `routes.ts`**

In `packages/console/src/api/routes.ts`, in the Optimize block, add after `OptimizeInstructionSchema`:

```ts
const DisabledArtifactSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  source: z.string(),
});
export type DisabledArtifact = z.infer<typeof DisabledArtifactSchema>;
```

Extend `OptimizePayloadSchema` to include:

```ts
  disabled: z.array(DisabledArtifactSchema),
```

Add after `optimizeRoute`:

```ts
const DisableItemSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  source: z.string(),
});
const DisableResultSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  ok: z.boolean(),
  message: z.string(),
});
export type DisableItem = z.infer<typeof DisableItemSchema>;
export type DisableResult = z.infer<typeof DisableResultSchema>;

export const disableArtifactsRoute = defineRoute("POST", "/api/optimize/disable", {
  body: z.object({ artifacts: z.array(DisableItemSchema) }),
  response: z.object({ results: z.array(DisableResultSchema) }),
});
export const enableArtifactsRoute = defineRoute("POST", "/api/optimize/enable", {
  body: z.object({ artifacts: z.array(DisableItemSchema) }),
  response: z.object({ results: z.array(DisableResultSchema) }),
});
```

- [ ] **Step 2: Wire the controller — imports, schemas, endpoints**

In `src/gem.controller.ts`:

Extend the capture import (line ~128):

```ts
import { introspectConfig, introspectProject, disableArtifacts, enableArtifacts, listDisabled } from "@agentgem/capture";
```

Add `disabled` to the controller's own `OptimizePayloadSchema` (line ~78):

```ts
export const OptimizePayloadSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]),
  artifacts: z.array(OptimizeArtifactSchema),
  instructions: z.array(OptimizeInstructionSchema),
  disabled: z.array(z.object({
    type: z.enum(["skill", "mcp", "plugin"]),
    name: z.string(),
    source: z.string(),
  })),
});
```

Add near `OptimizeQuerySchema`:

```ts
const DisableItemSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  source: z.string(),
});
const DisableBodySchema = z.object({ artifacts: z.array(DisableItemSchema) });
const DisableResponseSchema = z.object({
  results: z.array(z.object({
    type: z.enum(["skill", "mcp", "plugin"]),
    name: z.string(),
    ok: z.boolean(),
    message: z.string(),
  })),
});
```

Extend the `optimize()` handler's return (line ~385):

```ts
    const payload = buildOptimizePayload(inv, usage, range, now);
    return { ...payload, disabled: listDisabled() };
```

Add the two endpoints right after `optimizeDiscoverInstall`:

```ts
  // Reversible deactivation of prune rows. originGuard-protected like every /api route.
  // Never throws: disableArtifacts/enableArtifacts map each item to { ok, message }.
  @post("/optimize/disable", { body: DisableBodySchema, response: DisableResponseSchema })
  async optimizeDisable(input: { body: z.infer<typeof DisableBodySchema> }): Promise<z.infer<typeof DisableResponseSchema>> {
    return { results: disableArtifacts(input.body.artifacts) };
  }

  @post("/optimize/enable", { body: DisableBodySchema, response: DisableResponseSchema })
  async optimizeEnable(input: { body: z.infer<typeof DisableBodySchema> }): Promise<z.infer<typeof DisableResponseSchema>> {
    return { results: enableArtifacts(input.body.artifacts) };
  }
```

- [ ] **Step 3: Write the endpoint test (delegation + payload shape)**

Create `src/gem/__tests__/disableEndpoints.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, enableArtifacts, listDisabled } from "@agentgem/capture";

// The controller endpoints are thin delegators; this locks the contract the controller
// relies on: disable → listDisabled reflects it → enable clears it, all reversible.
let home: string, opts: { claudeDir: string; agentDir: string; codexDir: string; hermesDir: string };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "disable-ep-"));
  opts = { claudeDir: join(home, ".claude"), agentDir: join(home, ".agents", "skills"), codexDir: join(home, ".codex"), hermesDir: join(home, ".hermes") };
  mkdirSync(join(opts.claudeDir, "skills", "demo"), { recursive: true });
  writeFileSync(join(opts.claudeDir, "skills", "demo", "SKILL.md"), "---\ndescription: d\n---\n#demo");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("disable/enable endpoint contract", () => {
  it("disable → listDisabled shows it → enable removes it", () => {
    const d = disableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(d).toEqual([{ type: "skill", name: "demo", ok: true, message: expect.stringMatching(/archived/) }]);
    expect(listDisabled(opts)).toContainEqual({ type: "skill", name: "demo", source: "standalone" });
    const e = enableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(e[0].ok).toBe(true);
    expect(listDisabled(opts)).toHaveLength(0);
    expect(existsSync(join(opts.claudeDir, "skills", "demo", "SKILL.md"))).toBe(true);
  });
});
```

- [ ] **Step 4: Build, typecheck, run**

Run:
```bash
pnpm build && npx vitest run src/gem/__tests__/disableEndpoints.test.ts
```
Expected: PASS. The `pnpm build` step also typechecks the controller (`tsc -b`) — it must compile with the new endpoints and payload field.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts src/gem.controller.ts src/gem/__tests__/disableEndpoints.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(api): /optimize/disable + /optimize/enable endpoints and disabled payload"
```

---

### Task 6: Frontend — multi-select Disable + Disabled section

**Files:**
- Modify: `packages/console/src/panels/Optimize/Dashboard.tsx`
- Test: `packages/console/src/panels/Optimize/DisableActions.test.tsx`
- Modify (CSS, only if a class is missing): `packages/console/src/panels/Optimize/*.css` — reuse existing `obs-*`/`opt-*` classes; add none unless a test needs it.

**Interfaces:**
- Consumes: `disableArtifactsRoute`, `enableArtifactsRoute`, `makeClient`, `OptimizePayload`, `DisabledArtifact` (Task 5); existing `onRefresh` prop.

- [ ] **Step 1: Write the failing UI test**

Create `packages/console/src/panels/Optimize/DisableActions.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Dashboard } from "./Dashboard.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const artifact = (over: Partial<any> = {}) => ({
  name: "old-skill", type: "skill", source: "standalone", contextTokens: 400, uses: 0,
  lastUsedMs: null, prune: true, change: { file: "~/.claude/skills/old-skill", key: "remove" }, ...over,
});
const payload = (over: Partial<any> = {}) => ({
  range: "30d", instructions: [],
  artifacts: [artifact(), artifact({ name: "kept", source: "distilled-draft", prune: false })],
  disabled: [], ...over,
});

describe("Prune disable actions", () => {
  it("selecting an eligible row arms 'Disable selected' and POSTs the checked items", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ results: [{ type: "skill", name: "old-skill", ok: true, message: "disabled" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={onRefresh} apiBase="" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /select old-skill/i }));
    fireEvent.click(screen.getByRole("button", { name: /disable selected \(1\)/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ artifacts: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("does not render a checkbox for ineligible (distilled-draft) rows", () => {
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} apiBase="" />);
    expect(screen.queryByRole("checkbox", { name: /select kept/i })).toBeNull();
  });

  it("renders the Disabled section and re-enables a row", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ results: [{ type: "skill", name: "old-skill", ok: true, message: "restored" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();
    const data = payload({ disabled: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    render(<Dashboard data={data} range="30d" onRange={() => {}} pending={false} onRefresh={onRefresh} apiBase="" />);
    expect(screen.getByText(/Disabled/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /re-enable old-skill/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ artifacts: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    expect(onRefresh).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Optimize/DisableActions.test.tsx`
Expected: FAIL (no checkbox / no Disable button / no Disabled section).

- [ ] **Step 3: Update `Dashboard.tsx`**

Replace the imports and the component body of `packages/console/src/panels/Optimize/Dashboard.tsx` with:

```tsx
// packages/console/src/panels/Optimize/Dashboard.tsx
import { useState } from "react";
import { fmtTokens } from "../Observe/data.js";
import {
  disableArtifactsRoute, enableArtifactsRoute, makeClient,
  type OptimizePayload, type OptimizeRange, type OptimizeArtifact, type DisabledArtifact,
} from "../../api/routes.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { DiscoverSection } from "./Discover.js";

const RANGES: OptimizeRange[] = ["today", "7d", "30d", "all"];

// A prune row is disable-eligible unless it comes from a source we can't reversibly
// deactivate (drafts / project-scoped). Everything else routes to a flag or archive move.
const INELIGIBLE = new Set(["distilled-draft", "project"]);
function eligible(a: OptimizeArtifact): boolean {
  return a.prune && !INELIGIBLE.has(a.source);
}
function key(a: { type: string; name: string; source: string }): string {
  return `${a.type}:${a.source}:${a.name}`;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function Dashboard({ data, range, onRange, pending, onRefresh, apiBase }: {
  data: OptimizePayload;
  range: OptimizeRange;
  onRange: (r: OptimizeRange) => void;
  pending: boolean;
  onRefresh?: () => void;
  apiBase: string;
}) {
  const prunable = data.artifacts.filter((a) => a.prune);
  const savings = prunable.reduce((acc, a) => acc + a.contextTokens, 0);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = (a: OptimizeArtifact) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(key(a)) ? next.delete(key(a)) : next.add(key(a));
    return next;
  });

  const disableSelected = () => {
    const artifacts = data.artifacts.filter((a) => selected.has(key(a)))
      .map((a) => ({ type: a.type, name: a.name, source: a.source }));
    if (!artifacts.length) return;
    setBusy(true); setNote(null);
    disableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts } })
      .then((r) => {
        const failed = r.results.filter((x) => !x.ok);
        setNote(failed.length ? `${failed.length} failed: ${failed.map((f) => `${f.name} (${f.message})`).join("; ")}` : null);
        setSelected(new Set());
        onRefresh?.();
      })
      .catch((e) => setNote(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  const reEnable = (d: DisabledArtifact) => {
    setBusy(true); setNote(null);
    enableArtifactsRoute.call(makeClient(apiBase), { body: { artifacts: [{ type: d.type, name: d.name, source: d.source }] } })
      .then((r) => {
        const f = r.results.find((x) => !x.ok);
        setNote(f ? `${f.name}: ${f.message}` : null);
        onRefresh?.();
      })
      .catch((e) => setNote(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="opt">
      <div className="opt-head">
        <div className="opt-ranges">
          {RANGES.map((r) => (
            <button key={r} className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>{r}</button>
          ))}
        </div>
        {pending && <span className="obs-muted">refreshing…</span>}
        {onRefresh && <RefreshButton onClick={onRefresh} busy={pending} />}
      </div>

      <DiscoverSection apiBase={apiBase} />

      <section className="opt-section">
        <h3>Prune — installed but unused <span className="obs-muted">({prunable.length}, ~{fmtTokens(savings)} est. context saved)</span></h3>
        <p className="obs-muted opt-note">Context tokens are estimates (chars/4). Disable is reversible: plugins/MCP flip a config flag; skills relocate to <code>~/.agentgem/disabled/</code>. Re-enable below.</p>
        <div className="opt-disc-actions">
          <button className="obs-range-btn" onClick={disableSelected} disabled={busy || selected.size === 0}>
            {busy ? "Working…" : `Disable selected (${selected.size})`}
          </button>
          {note && <span className="obs-error" title={note}>{note}</span>}
        </div>
        <table className="obs-table">
          <thead><tr><th></th><th>artifact</th><th>type</th><th>source</th><th>est. ctx</th><th>uses</th><th>last used</th><th>to disable</th></tr></thead>
          <tbody>
            {data.artifacts.map((a) => (
              <tr key={a.type + ":" + a.name} className={a.prune ? "opt-prune" : ""}>
                <td>{eligible(a)
                  ? <input type="checkbox" aria-label={`select ${a.name}`} checked={selected.has(key(a))} onChange={() => toggle(a)} />
                  : null}</td>
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

      {data.disabled.length > 0 && (
        <section className="opt-section">
          <h3>Disabled <span className="obs-muted">({data.disabled.length}) · reversible</span></h3>
          <table className="obs-table">
            <thead><tr><th>artifact</th><th>type</th><th>source</th><th>re-enable</th></tr></thead>
            <tbody>
              {data.disabled.map((d) => (
                <tr key={d.type + ":" + d.source + ":" + d.name}>
                  <td>{d.name}</td>
                  <td><span className="obs-chip">{d.type}</span></td>
                  <td className="obs-muted">{d.source}</td>
                  <td><button className="obs-range-btn" disabled={busy} aria-label={`re-enable ${d.name}`} onClick={() => reEnable(d)}>Re-enable</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="opt-section">
        <h3>Instructions health <span className="obs-muted">global · loaded every session</span></h3>
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
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/console && npx vitest run src/panels/Optimize/DisableActions.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full console suite + typecheck (guard existing Optimize tests)**

Run: `cd packages/console && npx vitest run && npx tsc -b`
Expected: PASS. (The existing `pages.test.ts`/Discover tests still pass; `OptimizePayload` now requires `disabled`, so any test constructing a payload must include it — update fixtures if the run flags a missing field.)

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Optimize/Dashboard.tsx packages/console/src/panels/Optimize/DisableActions.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): multi-select Disable + Re-enable in Optimize Prune table"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Build + full root suite**

Run: `pnpm build && npx vitest run`
Expected: PASS. If pre-existing real-FS scan tests (`observeScan`/`scorecard`) time out under concurrency, re-run them in isolation to confirm they're the known flake, not a regression.

- [ ] **Step 2: Console suite + typecheck**

Run: `cd packages/console && npx vitest run && npx tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit any fixture fixups**

If Steps 1–2 required fixture updates (e.g. adding `disabled: []` to an Optimize payload fixture), commit them:

```bash
git add -A
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "test: add disabled[] to Optimize payload fixtures"
```

---

## Self-Review

**Spec coverage:**
- Multi-select disable → Task 6 (checkboxes + "Disable selected"). ✓
- Reversible mechanisms (plugin flag / .mcp.json flag / skill move / settings.json stash) → Tasks 2–4. ✓
- Archive `~/.agentgem/disabled/`, provenance-encoded, agent-neutral → Task 2 `archiveRoot`. ✓
- Consistency across Claude/Agents/Codex/Hermes → Task 1 shared resolver + Task 2 4-agent round-trip test. ✓
- MCP origin resolution (settings.json vs .mcp.json under flattened `source:"user"`) → Task 4. ✓
- Disabled section + Re-enable → Task 6; `listDisabled` + payload `disabled` → Tasks 2–5. ✓
- Never-throws batch + strict validation + no-clobber → Task 2 tests. ✓
- Ineligible rows shown without a checkbox → Task 6 `eligible()` + test. ✓
- Single-fetch (fold `disabled` into GET /api/optimize) → Task 5. ✓

**Placeholder scan:** No TBD/TODO. The Task 2 module intentionally ships plugin/mcp as explicit stubs that return `ok:false` (not silent) and are replaced with full code in Tasks 3–4 — each task is independently testable.

**Type consistency:** `DisableItem`/`DisableResult`/`DisabledArtifact` use identical `{type: "skill"|"mcp"|"plugin", name, source}` shapes in capture (Tasks 2–4), the controller and `routes.ts` (Task 5), and the UI POST bodies (Task 6). `resolveSkillRoot`/`SKILL_SOURCES` names match across Tasks 1–4. `listDisabled` is grown additively across Tasks 2→3→4 with consistent row shapes.
